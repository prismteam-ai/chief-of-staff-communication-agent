#!/usr/bin/env tsx
/**
 * `just reclassify-nodraft` (pre-demo fix 1a): the confidence-gate fix (`confidence.ts`'s
 * `routeRecommendation`/`NO_DRAFT_ACTION_TYPES`, `run-agent-turn.ts`) is correct going forward, but
 * was never retroactive — every `fyi_no_reply`/`escalate` communication drafted by the OLD routing
 * (which drafted a reply for ANY actionType once confidence cleared the threshold) is still sitting
 * in `drafted`/`awaiting_approval` with a fabricated auto-reply and a live "Approve & send" button.
 * A reviewer scrubbing the queue sees state that directly contradicts the fix.
 *
 * This script finds every such record and legally corrects it to the outcome the FIXED pipeline
 * would have produced:
 *   - `fyi_no_reply` → `dismissed` (no reply owed — `state-machine.ts`'s documented
 *     `recommended → dismissed` outcome, reached here via the existing `drafted → dismissed` edge)
 *   - `escalate` → `needs_context` (surfaced to a human, never an auto-drafted reply — reached here
 *     via the `drafted → needs_context` edge added for exactly this backfill, see
 *     `state-machine.ts`'s "pre-demo backfill fix" doc comment)
 * and REMOVES the stale `draft` attribute so no card renders old draft text under the corrected
 * status either (`CommunicationCard.tsx` renders `c.draft && ...` unconditionally, independent of
 * `status` — a lingering `draft` field would still show under the unified queue / recommended-
 * actions views even once `status` no longer permits an Approve action).
 *
 * A record already at `awaiting_approval` (opened for review, one hop further than `drafted`) has
 * no direct edge to `dismissed`/`needs_context` — it reaches `drafted` first via the existing
 * `awaiting_approval → rejected → drafted` re-draft chain (three total hops), persisted as ONE
 * atomic conditional write, same pattern `approval-service.ts`'s `moveChain` uses for `editDraft`/
 * `rejectDraft`.
 *
 * Every hop is validated through `applyTransition` (the shared state machine) — no hand-poked
 * `status` write. Account-scoped: enumerates every account and queries the `byAccountStatus` GSI
 * per account/status rather than a blind table scan. Idempotent: a record only matches while its
 * `status` is `drafted`/`awaiting_approval`, so once corrected it naturally drops out of the query
 * on a re-run; the persisting `UpdateCommand` also carries a `ConditionExpression` on the status it
 * observed, so a concurrent/duplicate run fails closed (skipped, logged) rather than double-applying.
 *
 * Also satisfies pre-demo fix 1b ("fresh clean examples demonstrating the no-draft branch"): the
 * live table has multiple `fyi_no_reply` and `escalate` records to correct (verified via a scan
 * before writing this script), so after this run the queue has real, correctly-routed examples of
 * both outcomes — no separate synthetic seed needed.
 *
 * ## Second pass: stale drafts already sitting in a terminal no-draft-owed state
 * Live verification (Playwright against the deployed dashboard) surfaced one more shape of the same
 * landmine, outside the `drafted`/`awaiting_approval` case above: a `fyi_no_reply` record dismissed
 * by a HUMAN via the pre-fix `drafted → dismissed` UI action (`approval-service.ts#dismiss`, which
 * never clears `draft` — it only moves `status`) still carries the stale draft attribute. `status`
 * is already correct (`dismissed`, no Approve action reachable), but `CommunicationCard.tsx` still
 * renders the stale "Draft reply:" text under it. This pass finds every ALREADY-`dismissed`
 * `fyi_no_reply` (symmetrically, `needs_context` `escalate`) record that still has a `draft` and
 * removes it — a pure attribute REMOVE, no state transition, since the status is already right.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  applyTransition,
  type CommunicationState,
  type TransitionRecord,
} from '@chief-of-staff/shared';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const ACCOUNT_STATUS_INDEX = 'byAccountStatus';
const ACTOR_ID = 'system:reclassify-nodraft';

/** The two actionTypes the confidence-gate fix routes to a no-draft outcome (mirrors
 * `confidence.ts`'s `NO_DRAFT_ACTION_TYPES` — kept as a literal set here rather than importing the
 * unexported const, matching this repo's convention of scripts depending only on the package's
 * public exports). */
const TARGET_STATUS: Record<'fyi_no_reply' | 'escalate', CommunicationState> = {
  fyi_no_reply: 'dismissed',
  escalate: 'needs_context',
};

/** The two stale statuses a pre-fix draft can be sitting in (first pass). */
const STALE_STATUSES: CommunicationState[] = ['drafted', 'awaiting_approval'];

interface StaleRecord {
  commId: string;
  accountId: string;
  status: CommunicationState;
  actionType: 'fyi_no_reply' | 'escalate';
}

function fail(message: string): never {
  console.error(`[reclassify-nodraft] FAIL: ${message}`);
  process.exit(1);
}

async function getStackOutput(stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey);
  if (!output?.OutputValue) {
    fail(`Stack output ${outputKey} not found on ${stackName} — deploy ${stackName} first.`);
  }
  return output.OutputValue;
}

async function listAccountIds(
  doc: DynamoDBDocumentClient,
  accountsTableName: string,
): Promise<string[]> {
  const result = await doc.send(
    new ScanCommand({ TableName: accountsTableName, ProjectionExpression: 'accountId' }),
  );
  return (result.Items ?? []).map((item) => item.accountId as string);
}

async function findStaleRecords(
  doc: DynamoDBDocumentClient,
  communicationsTableName: string,
  accountIds: string[],
): Promise<StaleRecord[]> {
  const stale: StaleRecord[] = [];
  for (const accountId of accountIds) {
    for (const status of STALE_STATUSES) {
      const result = await doc.send(
        new QueryCommand({
          TableName: communicationsTableName,
          IndexName: ACCOUNT_STATUS_INDEX,
          KeyConditionExpression: 'accountId = :accountId AND #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':accountId': accountId, ':status': status },
          ProjectionExpression: 'commId, accountId, #status, recommendation',
        }),
      );
      for (const item of result.Items ?? []) {
        const actionType = item.recommendation?.actionType as string | undefined;
        if (actionType === 'fyi_no_reply' || actionType === 'escalate') {
          stale.push({
            commId: item.commId as string,
            accountId: item.accountId as string,
            status: item.status as CommunicationState,
            actionType,
          });
        }
      }
    }
  }
  return stale;
}

/** Builds the legal hop sequence from `record.status` to its corrected no-draft destination —
 * either one hop (already `drafted`) or three (via the `rejected → drafted` re-draft chain from
 * `awaiting_approval`) — each validated by `applyTransition`. */
function buildTransitionChain(record: StaleRecord, now: () => Date): TransitionRecord[] {
  const target = TARGET_STATUS[record.actionType];
  const path: CommunicationState[] =
    record.status === 'awaiting_approval' ? ['rejected', 'drafted', target] : [target];

  const transitions: TransitionRecord[] = [];
  let from = record.status;
  for (const to of path) {
    transitions.push(
      applyTransition({
        commId: record.commId,
        accountId: record.accountId,
        from,
        to,
        actorId: ACTOR_ID,
        now,
      }),
    );
    from = to;
  }
  return transitions;
}

async function correctRecord(
  doc: DynamoDBDocumentClient,
  communicationsTableName: string,
  record: StaleRecord,
  now: () => Date,
): Promise<'corrected' | 'skipped_conflict'> {
  const transitions = buildTransitionChain(record, now);
  const finalStatus = transitions[transitions.length - 1]!.to;

  try {
    await doc.send(
      new UpdateCommand({
        TableName: communicationsTableName,
        Key: { commId: record.commId },
        UpdateExpression:
          'SET #status = :status, transitions = list_append(if_not_exists(transitions, :empty), :newTransitions) REMOVE draft',
        ConditionExpression: '#status = :expectedFrom',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': finalStatus,
          ':newTransitions': transitions,
          ':empty': [] as TransitionRecord[],
          ':expectedFrom': record.status,
        },
      }),
    );
    return 'corrected';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return 'skipped_conflict';
    }
    throw error;
  }
}

/** Second pass: records already sitting in the CORRECT no-draft-owed status (`TARGET_STATUS`) for
 * their actionType, but still carrying a stale `draft` from before that status was reached by a
 * pre-fix human `dismiss` action rather than by this script (see module doc comment). Pure
 * attribute cleanup — no state transition, `status` is already right. */
async function findStaleDraftsOnTerminalRecords(
  doc: DynamoDBDocumentClient,
  communicationsTableName: string,
  accountIds: string[],
): Promise<StaleRecord[]> {
  const stale: StaleRecord[] = [];
  for (const accountId of accountIds) {
    for (const [actionType, status] of Object.entries(TARGET_STATUS) as Array<
      ['fyi_no_reply' | 'escalate', CommunicationState]
    >) {
      const result = await doc.send(
        new QueryCommand({
          TableName: communicationsTableName,
          IndexName: ACCOUNT_STATUS_INDEX,
          KeyConditionExpression: 'accountId = :accountId AND #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':accountId': accountId, ':status': status },
          ProjectionExpression: 'commId, accountId, #status, recommendation, draft',
        }),
      );
      for (const item of result.Items ?? []) {
        if (item.recommendation?.actionType === actionType && item.draft !== undefined) {
          stale.push({
            commId: item.commId as string,
            accountId: item.accountId as string,
            status: item.status as CommunicationState,
            actionType,
          });
        }
      }
    }
  }
  return stale;
}

/** Removes a stale `draft` with no status change — conditional on the draft still being present,
 * so a concurrent/duplicate run is a no-op rather than an error. */
async function clearStaleDraft(
  doc: DynamoDBDocumentClient,
  communicationsTableName: string,
  commId: string,
): Promise<'cleared' | 'skipped_conflict'> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: communicationsTableName,
        Key: { commId },
        UpdateExpression: 'REMOVE draft',
        ConditionExpression: 'attribute_exists(draft)',
      }),
    );
    return 'cleared';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return 'skipped_conflict';
    }
    throw error;
  }
}

async function main() {
  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  const communicationsTableName = await getStackOutput('IngestStack', 'CommunicationsTableName');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const now = () => new Date();

  const accountIds = await listAccountIds(doc, accountsTableName);
  if (accountIds.length === 0) {
    console.log('[reclassify-nodraft] No accounts found — nothing to correct.');
    return;
  }

  const stale = await findStaleRecords(doc, communicationsTableName, accountIds);
  if (stale.length === 0) {
    console.log(
      '[reclassify-nodraft] Pass 1: no stale drafted/awaiting_approval records found across ' +
        `${accountIds.length} account(s).`,
    );
  } else {
    console.log(
      `[reclassify-nodraft] Pass 1: found ${stale.length} stale record(s) across ${accountIds.length} account(s):`,
    );

    let corrected = 0;
    let conflicts = 0;
    for (const record of stale) {
      const target = TARGET_STATUS[record.actionType];
      const outcome = await correctRecord(doc, communicationsTableName, record, now);
      if (outcome === 'corrected') {
        corrected++;
        console.log(
          `  corrected ${record.commId} (${record.actionType}): ${record.status} -> ${target}, draft removed`,
        );
      } else {
        conflicts++;
        console.log(
          `  skipped ${record.commId}: status changed since read (concurrent writer or already corrected)`,
        );
      }
    }
    console.log(
      `[reclassify-nodraft] Pass 1 done. Corrected ${corrected}, skipped ${conflicts} (conflict).`,
    );
  }

  // Pass 2: already-terminal-correct records with a leftover stale draft (see module doc comment).
  const staleTerminal = await findStaleDraftsOnTerminalRecords(
    doc,
    communicationsTableName,
    accountIds,
  );
  if (staleTerminal.length === 0) {
    console.log(
      '[reclassify-nodraft] Pass 2: no leftover stale drafts on already-correct records.',
    );
    return;
  }

  console.log(
    `[reclassify-nodraft] Pass 2: found ${staleTerminal.length} leftover stale draft(s):`,
  );
  let cleared = 0;
  let clearConflicts = 0;
  for (const record of staleTerminal) {
    const outcome = await clearStaleDraft(doc, communicationsTableName, record.commId);
    if (outcome === 'cleared') {
      cleared++;
      console.log(
        `  cleared stale draft on ${record.commId} (${record.actionType}, ${record.status})`,
      );
    } else {
      clearConflicts++;
      console.log(`  skipped ${record.commId}: draft already cleared since read`);
    }
  }
  console.log(
    `[reclassify-nodraft] Pass 2 done. Cleared ${cleared}, skipped ${clearConflicts} (conflict).`,
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

#!/usr/bin/env tsx
/**
 * `just seed-needs-context` (slowking fix 5): the supply-context AC (design.md §7 "prompt the user
 * for more information when confidence is low") was undemonstrable — 0 communications ever landed
 * in `needs_context` in the deployed demo data, because `seed-demo.ts`'s fixtures are all clear-cut
 * enough that the real agent classifies them above the confidence threshold. This script writes ONE
 * synthetic communication directly into the CommunicationsTable, already in the exact shape a real
 * low-confidence agent turn would have persisted (`recommendation` + two transitions,
 * `ingested -> recommended -> needs_context`, no draft) — so the dashboard's "needs context" view
 * has something to show without depending on Bedrock actually returning a low-confidence score for
 * some fixture (non-deterministic, and there's no env knob to lower the threshold for one message).
 *
 * Deliberately vague body (Task 5 style: an agent reading it genuinely could not say what's being
 * asked or by when) — realistic-but-synthetic, no third-party PII, matching `seed-demo.ts`'s
 * convention.
 *
 * Idempotent: fixed `externalId`, so re-running upserts the SAME `commId` — safe to re-run, never
 * piles up duplicates (unlike `seed-demo.ts`'s intentional "tops up" realism-at-scale posture,
 * this script seeds exactly one fixture).
 *
 * Once seeded, a reviewer can drive the REAL `supplyContext` flow against it from the dashboard
 * (types context text -> `awaiting_reprocess` -> re-enqueued to the real agent -> re-classified) —
 * only the INITIAL low-confidence outcome is synthesized; the recovery path is the genuine pipeline.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { applyTransition, commIdFor, type NormalizedMessage } from '@chief-of-staff/shared';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
/** Fixed externalId -> fixed commId -> idempotent re-runs (see module doc comment). */
const SEED_EXTERNAL_ID = 'seed-needs-context-fixture-1';
const SEED_CHANNEL: NormalizedMessage['channelType'] = 'gmail';
const SEED_COMM_ID = commIdFor(SEED_CHANNEL, SEED_EXTERNAL_ID);

function fail(message: string): never {
  console.error(`[seed-needs-context] FAIL: ${message}`);
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

/** Same "first connected Gmail account" lookup `seed-demo.ts` uses — the needs_context fixture
 * seeds into whichever mailbox is already connected, no separate account-picking step. */
async function findConnectedGmailAccount(
  doc: DynamoDBDocumentClient,
  accountsTableName: string,
): Promise<{ accountId: string; address: string } | undefined> {
  const result = await doc.send(
    new ScanCommand({
      TableName: accountsTableName,
      FilterExpression: 'channelType = :c',
      ExpressionAttributeValues: { ':c': 'gmail' },
    }),
  );
  const account = result.Items?.[0];
  if (!account) return undefined;
  return { accountId: account.accountId as string, address: account.displayName as string };
}

async function main() {
  const accountsTableName = await getStackOutput('IngestStack', 'AccountsTableName');
  const communicationsTableName = await getStackOutput('IngestStack', 'CommunicationsTableName');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const account = await findConnectedGmailAccount(doc, accountsTableName);
  if (!account) {
    fail('No connected Gmail account found — run `just gmail-auth` first.');
  }

  const now = () => new Date();
  const nowIso = now().toISOString();

  const message: NormalizedMessage = {
    schemaVersion: 1,
    channelType: SEED_CHANNEL,
    accountId: account.accountId,
    externalId: SEED_EXTERNAL_ID,
    threadKey: `thread-${SEED_EXTERNAL_ID}`,
    participants: [
      { id: account.address, role: 'to' },
      { id: 'priya.chen@example-partners.test', displayName: 'Priya Chen', role: 'from' },
    ],
    ts: nowIso,
    subject: 'Following up',
    // Deliberately vague — no clear ask, deadline, or subject the agent could act on confidently.
    body: 'Hey — following up on the thing from last week. Let me know your thoughts whenever you get a chance.',
    attachments: [],
  };

  const recommendation = {
    commId: SEED_COMM_ID,
    accountId: account.accountId,
    actionType: 'needs_context' as const,
    confidence: 0.35,
    rationale:
      'Message is too vague to classify confidently — no clear subject, deadline, or requested action.',
  };

  const transitions = [
    applyTransition({
      commId: SEED_COMM_ID,
      accountId: account.accountId,
      from: 'ingested',
      to: 'recommended',
      actorId: 'system',
      now,
    }),
    applyTransition({
      commId: SEED_COMM_ID,
      accountId: account.accountId,
      from: 'recommended',
      to: 'needs_context',
      actorId: 'system',
      now,
    }),
  ];

  await doc.send(
    new PutCommand({
      TableName: communicationsTableName,
      Item: {
        ...message,
        commId: SEED_COMM_ID,
        status: 'needs_context',
        ingestedAt: nowIso,
        recommendation,
        transitions,
      },
    }),
  );

  console.log(
    `[seed-needs-context] Seeded ${SEED_COMM_ID} into account ${account.accountId} (status: needs_context, confidence: ${recommendation.confidence}).`,
  );
  console.log(
    '[seed-needs-context] Open the dashboard\'s Drafts/queue view and use "Supply context" to drive the real re-classification.',
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

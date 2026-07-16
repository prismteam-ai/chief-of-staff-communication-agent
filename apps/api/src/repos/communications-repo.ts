import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  CommunicationState,
  Draft,
  NormalizedMessage,
  Recommendation,
  TransitionRecord,
} from '@chief-of-staff/shared';

/**
 * Communications table repository for the API/approval layer (Task 6, design.md §7/§8). Mirrors
 * the shape `apps/agent-handler/src/communications-repo.ts` and `apps/ingest/src/communications-repo.ts`
 * already agree on — one item per `commId` — and adds the two capabilities the approval loop needs
 * that neither of those owns yet: an account-scoped list query (the `byAccountStatus` GSI
 * `lib/constructs/data-tables.ts` already provisions) and a generic conditional state-transition
 * write (generalizing `AgentCommunicationsRepo.persistOutcome`'s single-purpose update into the
 * approve/edit/reject/dismiss/supplyContext/send/answered set of moves the approval router drives).
 *
 * `sentMessageId`/`sendClaimedAt` are additive fields on the same item (Task 6 brief constraint 2:
 * send idempotency via conditional write) — no new table, no GSI change.
 */
export interface ApiCommunicationRecord extends NormalizedMessage {
  commId: string;
  status: CommunicationState;
  ingestedAt: string;
  recommendation?: Recommendation;
  draft?: Draft;
  transitions?: TransitionRecord[];
  /** Set once `approveDraft` claims the send — the idempotency guard (see `claimSend`). */
  sendClaimedAt?: string;
  /** Set on provider send confirmation (Gmail's returned message id) — proof the send happened. */
  sentMessageId?: string;
  /**
   * Free-text context supplied by the user via `supplyContext` (Task 6 review fix), appended to
   * (never replacing) any prior entries — a `needs_context` record can be re-supplied more than
   * once across re-runs. Threaded into the re-triggered agent turn's classify/draft prompt as
   * additional history so the re-classification is actually grounded in what the user provided,
   * not discarded.
   */
  suppliedContext?: string[];
}

let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cachedClient;
}

export const ACCOUNT_STATUS_INDEX = 'byAccountStatus';

export class TransitionConflictError extends Error {
  constructor(
    public readonly commId: string,
    public readonly expectedFrom: CommunicationState,
  ) {
    super(
      `Communication "${commId}" was not in state "${expectedFrom}" when the transition was applied ` +
        '(concurrent writer, or a retried request that already succeeded).',
    );
    this.name = 'TransitionConflictError';
  }
}

export class SendAlreadyClaimedError extends Error {
  constructor(public readonly commId: string) {
    super(
      `Communication "${commId}" already has a claimed/completed send — refusing to send again.`,
    );
    this.name = 'SendAlreadyClaimedError';
  }
}

export interface CommunicationsRepo {
  getById(commId: string): Promise<ApiCommunicationRecord | undefined>;
  listByAccount(accountId: string, status?: CommunicationState): Promise<ApiCommunicationRecord[]>;

  /**
   * Applies one already-validated `TransitionRecord` (the caller runs it through
   * `applyTransition` first — this repo does not re-derive legality, only persists it): sets
   * `status` to `record.to`, appends the record to the audit trail, optionally merges `draft`
   * (the `editDraft` case) and/or appends one entry to `suppliedContext` (the `supplyContext` case,
   * Task 6 review fix — see `ApiCommunicationRecord.suppliedContext`). The `ConditionExpression`
   * guards against a concurrent/duplicate writer having already moved the record off `record.from`
   * — fails closed with `TransitionConflictError` rather than silently double-applying.
   */
  transition(
    record: TransitionRecord,
    patch?: { draft?: Draft; appendSuppliedContext?: string },
  ): Promise<void>;

  /**
   * Send-idempotency claim (Task 6 brief constraint 2): a conditional write that only succeeds
   * once per communication. `approveDraft` calls this immediately before invoking the connector's
   * `send` — a retried/duplicate approval request for a communication that already has a claim
   * throws `SendAlreadyClaimedError` instead of sending a second time.
   *
   * `priorClaimedAt`, when passed, is the retry-after-failure path (`approveDraft` on a record
   * already in `approved` with no `sentMessageId` — see its doc comment): the claim is re-issued
   * with a fresh timestamp via a CAS on the EXACT prior `sendClaimedAt` value rather than
   * `attribute_not_exists`. This still only succeeds once per prior claim — two concurrent retries
   * both reading the same prior timestamp race on the same CAS and only one wins, exactly as the
   * first-attempt case only lets one caller through `attribute_not_exists` — so the send-once
   * guarantee holds for retries too, not just first attempts.
   */
  claimSend(commId: string, priorClaimedAt?: string): Promise<void>;

  /** Persists the provider's send confirmation id — called once the connector confirms delivery. */
  recordSent(commId: string, sentMessageId: string): Promise<void>;
}

export function createCommunicationsRepo(tableName: string): CommunicationsRepo {
  return {
    async getById(commId) {
      const result = await client().send(new GetCommand({ TableName: tableName, Key: { commId } }));
      return result.Item as ApiCommunicationRecord | undefined;
    },

    async listByAccount(accountId, status) {
      const result = await client().send(
        new QueryCommand({
          TableName: tableName,
          IndexName: ACCOUNT_STATUS_INDEX,
          KeyConditionExpression: status
            ? 'accountId = :accountId AND #status = :status'
            : 'accountId = :accountId',
          ExpressionAttributeNames: status ? { '#status': 'status' } : undefined,
          ExpressionAttributeValues: {
            ':accountId': accountId,
            ...(status ? { ':status': status } : {}),
          },
        }),
      );
      return (result.Items ?? []) as ApiCommunicationRecord[];
    },

    async transition(record, patch) {
      const setClauses = [
        '#status = :status',
        'transitions = list_append(if_not_exists(transitions, :empty), :newTransition)',
      ];
      const values: Record<string, unknown> = {
        ':status': record.to,
        ':newTransition': [record],
        ':empty': [] as TransitionRecord[],
        ':expectedFrom': record.from,
      };

      if (patch?.draft) {
        setClauses.push('draft = :draft');
        values[':draft'] = patch.draft;
      }

      if (patch?.appendSuppliedContext) {
        setClauses.push(
          'suppliedContext = list_append(if_not_exists(suppliedContext, :emptyContext), :newContext)',
        );
        values[':emptyContext'] = [] as string[];
        values[':newContext'] = [patch.appendSuppliedContext];
      }

      try {
        await client().send(
          new UpdateCommand({
            TableName: tableName,
            Key: { commId: record.commId },
            UpdateExpression: `SET ${setClauses.join(', ')}`,
            ConditionExpression: '#status = :expectedFrom',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: values,
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new TransitionConflictError(record.commId, record.from);
        }
        throw error;
      }
    },

    async claimSend(commId, priorClaimedAt) {
      const isRetry = priorClaimedAt !== undefined;
      try {
        await client().send(
          new UpdateCommand({
            TableName: tableName,
            Key: { commId },
            UpdateExpression: 'SET sendClaimedAt = :now',
            // First attempt: only one caller may ever see no claim at all. Retry-after-failure:
            // only one caller may win the CAS on the exact prior claim timestamp AND the send must
            // still be unconfirmed — `sentMessageId` existing means a prior attempt's connector
            // call actually succeeded despite throwing (e.g. the response was lost after Gmail
            // accepted it), which must never be re-claimed for a second send.
            ConditionExpression: isRetry
              ? 'sendClaimedAt = :priorClaimedAt AND attribute_not_exists(sentMessageId)'
              : 'attribute_not_exists(sendClaimedAt)',
            ExpressionAttributeValues: {
              ':now': new Date().toISOString(),
              ...(isRetry ? { ':priorClaimedAt': priorClaimedAt } : {}),
            },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new SendAlreadyClaimedError(commId);
        }
        throw error;
      }
    },

    async recordSent(commId, sentMessageId) {
      await client().send(
        new UpdateCommand({
          TableName: tableName,
          Key: { commId },
          UpdateExpression: 'SET sentMessageId = :sentMessageId',
          ConditionExpression: 'attribute_exists(commId)',
          ExpressionAttributeValues: { ':sentMessageId': sentMessageId },
        }),
      );
    },
  };
}

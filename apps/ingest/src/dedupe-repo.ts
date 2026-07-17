import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Dedupe table repository — idempotency owned by the ingress (docs/decisions/email-ingress.md §5,
 * brief constraint 3: "dedupe on provider message id via conditional write"). One item per
 * provider `externalId`; a `ConditionExpression: attribute_not_exists(dedupeKey)` PutCommand is
 * the entire mechanism — DynamoDB serializes the check-and-write atomically, so two concurrent
 * processor invocations for the same message id can never both win.
 *
 * TTL (`expiresAt`, wired on the table in `DataTables`) bounds the dedupe window rather than
 * growing this table forever — redelivery beyond the TTL window is accepted as out of scope for a
 * demo-scale system (SQS's own redelivery window is far shorter than the TTL set here).
 *
 * Final-review fix: `release` exists to undo a `claim()` when the downstream persist that claim was
 * guarding never completed (see `processor-logic.ts`'s `claimThenPersistIsolated` — the whole
 * reason the claim happens BEFORE persistence, per the module doc comment above, is so a concurrent
 * duplicate can never win the race; but that ordering means a claim can succeed and then the
 * message never gets durably written if `putRawMessage`/`putIngested` throws. Without a release,
 * the dedupe key stays claimed for the full 30-day TTL and the message is permanently lost — no
 * redelivery, retry, or manual replay can ever get past the claim again for that provider message
 * id. `release` is best-effort by design (see its own doc comment): TTL is the backstop if it also
 * fails.
 */

const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — comfortably beyond any SQS/EventBridge retry window.

let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export function dedupeKeyFor(channelType: string, externalId: string): string {
  return `${channelType}#${externalId}`;
}

export interface DedupeRepo {
  /**
   * Attempts to claim `dedupeKey` for processing. Returns `true` if this call won the claim
   * (first time seeing this message), `false` if another call already claimed it (a duplicate
   * delivery/replay) — the caller uses this to decide whether to persist the message or skip it.
   */
  claim(dedupeKey: string): Promise<boolean>;
  /**
   * Releases a claim this call made, so a subsequent redelivery of the same provider message id is
   * treated as a fresh attempt instead of a permanent duplicate. ONLY call this when the persist the
   * claim was guarding did NOT complete — releasing after a successful persist would let a
   * redelivery race the now-durable record. Best-effort: a failure here is a rollback-of-a-rollback
   * situation with no further recourse in this call, so the caller logs a warn and lets the 30-day
   * TTL be the eventual backstop rather than throwing and masking the original failure that
   * triggered the release.
   */
  release(dedupeKey: string): Promise<void>;
}

export function createDedupeRepo(tableName: string): DedupeRepo {
  return {
    async claim(dedupeKey) {
      const now = Math.floor(Date.now() / 1000);
      try {
        await client().send(
          new PutCommand({
            TableName: tableName,
            Item: {
              dedupeKey,
              claimedAt: new Date().toISOString(),
              expiresAt: now + DEDUPE_TTL_SECONDS,
            },
            ConditionExpression: 'attribute_not_exists(dedupeKey)',
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          return false;
        }
        throw error;
      }
    },

    async release(dedupeKey) {
      // Unconditional delete — this call is only ever invoked right after this SAME invocation's
      // own successful claim (see the interface doc comment), so there is no concurrent-writer race
      // to guard against here the way `claim`'s ConditionExpression guards the write.
      await client().send(new DeleteCommand({ TableName: tableName, Key: { dedupeKey } }));
    },
  };
}

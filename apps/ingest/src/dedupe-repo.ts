import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

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
}

export function createDedupeRepo(tableName: string): DedupeRepo {
  return {
    async claim(dedupeKey) {
      const now = Math.floor(Date.now() / 1000);
      try {
        await client().send(
          new PutCommand({
            TableName: tableName,
            Item: { dedupeKey, claimedAt: new Date().toISOString(), expiresAt: now + DEDUPE_TTL_SECONDS },
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
  };
}

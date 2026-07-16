import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Dedupe table repository for the WhatsApp inbound webhook (Task 9) — identical shape/semantics to
 * `apps/ingest/src/dedupe-repo.ts` (idempotency owned by the ingress, docs/decisions/email-ingress.md
 * §5). A small app-local copy rather than a cross-app import (mirrors how `agent-trigger.ts` and
 * `communications-repo.ts` are independently defined per app): the webhook Lambda lives in
 * `apps/api` (it must share the deployed API Gateway's stable URL — see `whatsapp-webhook.ts`), but
 * writes into the SAME shared dedupe table `IngestStack` owns.
 */

const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — same window as the ingest-side table.

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
   * Attempts to claim `dedupeKey` for processing. Returns `true` if this call won the claim (first
   * time seeing this message), `false` if another call already claimed it (a duplicate Twilio
   * redelivery) — the caller uses this to decide whether to persist the message or skip it.
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
  };
}

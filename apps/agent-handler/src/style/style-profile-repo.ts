import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { StyleProfileRecordSchema, type StyleProfileRecord } from '@chief-of-staff/shared';

/**
 * Style-profiles table repository (PK `userId`, `lib/constructs/data-tables.ts`, Task 2). One item
 * per user — the same "one repo module per app, direct DynamoDB client" convention every other repo
 * in this codebase follows (`apps/ingest/src/accounts-repo.ts`, `apps/ingest/src/dedupe-repo.ts`).
 *
 * `put` is a plain upsert, not a conditional write: unlike the communications state machine, a
 * style profile has no illegal-transition concept — a rebuild is expected to happen more than once
 * as the sent-history corpus grows (`just build-style-profile` is documented idempotent-in-spirit,
 * brief constraint 4), and the feedback loop's `bumpSourceCount` (below) is a small, safe
 * read-then-write rather than a DynamoDB atomic counter, because it also needs to be a no-op when
 * no profile exists yet (a user who approves a draft before ever running `build-style-profile`).
 */
let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export interface StyleProfileRepo {
  get(userId: string): Promise<StyleProfileRecord | undefined>;
  put(record: StyleProfileRecord): Promise<void>;
  /**
   * Feedback-loop hook (design.md §6 "approved and edited drafts feed back into the profile"):
   * bumps `sourceCount` and `updatedAt` on an EXISTING profile. Returns `false` (a no-op) when no
   * profile exists yet for this user — the exemplar is still indexed by the caller regardless (see
   * `apps/api`'s feedback-loop wiring), but there is no style card to attribute a "learned from
   * this" count to until `build-style-profile` has run at least once.
   */
  bumpSourceCount(userId: string): Promise<boolean>;
}

export function createStyleProfileRepo(tableName: string): StyleProfileRepo {
  return {
    async get(userId) {
      const result = await client().send(new GetCommand({ TableName: tableName, Key: { userId } }));
      if (!result.Item) return undefined;
      return StyleProfileRecordSchema.parse(result.Item);
    },

    async put(record) {
      const validated = StyleProfileRecordSchema.parse(record);
      await client().send(new PutCommand({ TableName: tableName, Item: validated }));
    },

    async bumpSourceCount(userId) {
      const result = await client().send(new GetCommand({ TableName: tableName, Key: { userId } }));
      if (!result.Item) return false;
      const existing = StyleProfileRecordSchema.parse(result.Item);
      const updated: StyleProfileRecord = {
        ...existing,
        sourceCount: existing.sourceCount + 1,
        updatedAt: new Date().toISOString(),
      };
      await client().send(new PutCommand({ TableName: tableName, Item: updated }));
      return true;
    },
  };
}

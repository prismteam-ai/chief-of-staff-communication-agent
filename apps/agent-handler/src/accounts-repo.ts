import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Account } from '@chief-of-staff/shared';

/**
 * Minimal read-only accounts lookup for the agent runtime (Task 10): `runAgentTurn` only has
 * `accountId` on the communication record, but the style-profiles table is keyed by `userId`
 * (design.md §6 "per-user style profile") — this is the ONE hop from one to the other. Mirrors
 * `apps/api/src/repos/accounts-repo.ts#getOwner` exactly (same table, same read), kept as its own
 * tiny module here rather than a shared package because every other repo in this codebase is
 * per-app (see `apps/ingest/src/accounts-repo.ts`'s doc comment precedent) and the agent Lambda
 * needs only this one field, never the full connect-channel listing the api layer's repo also owns.
 */
let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export interface AgentAccountsRepo {
  getOwner(accountId: string): Promise<string | undefined>;
}

export function createAgentAccountsRepo(tableName: string): AgentAccountsRepo {
  return {
    async getOwner(accountId) {
      const result = await client().send(
        new GetCommand({ TableName: tableName, Key: { accountId } }),
      );
      return (result.Item as Account | undefined)?.userId;
    },
  };
}

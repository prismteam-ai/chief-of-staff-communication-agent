import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { McpTokenRecord } from '@chief-of-staff/shared';

/**
 * MCP token table repository (Task 11, design.md §8). PK `tokenHash` — never the plaintext token,
 * mirroring `Account.credentialSecretArn`'s "reference only" discipline (design.md §10). A
 * `PutCommand` with `attribute_not_exists(tokenHash)` makes issuance collision-safe: a SHA-256
 * digest collision on a 32-byte random token is cryptographically negligible, but the conditional
 * write still fails closed rather than silently overwriting another user's token record.
 */

let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cachedClient;
}

export interface McpTokensRepo {
  put(record: McpTokenRecord): Promise<void>;
  getByHash(tokenHash: string): Promise<McpTokenRecord | undefined>;
  touchLastUsed(tokenHash: string, at: string): Promise<void>;
}

export function createMcpTokensRepo(tableName: string): McpTokensRepo {
  return {
    async put(record) {
      await client().send(
        new PutCommand({
          TableName: tableName,
          Item: record,
          ConditionExpression: 'attribute_not_exists(tokenHash)',
        }),
      );
    },
    async getByHash(tokenHash) {
      const result = await client().send(
        new GetCommand({ TableName: tableName, Key: { tokenHash } }),
      );
      return result.Item as McpTokenRecord | undefined;
    },
    async touchLastUsed(tokenHash, at) {
      // Best-effort bookkeeping only — callers isolate failures here (see mcp-auth.ts), never let
      // this block or fail the authenticated call it is being recorded for.
      await client().send(
        new UpdateCommand({
          TableName: tableName,
          Key: { tokenHash },
          UpdateExpression: 'SET lastUsedAt = :at',
          ExpressionAttributeValues: { ':at': at },
        }),
      );
    },
  };
}

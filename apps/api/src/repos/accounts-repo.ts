import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { Account } from '@chief-of-staff/shared';

/**
 * Read-only accounts table access for the API layer (design.md §10, brief constraint 3: "ALL
 * enforce the account permission guard"). The approval router calls `getOwner` to build the
 * `AccountOwnershipMap` the shared `assertAccountAccess` guard checks against — never trusting a
 * client-asserted `accountId` without this server-side lookup.
 */
let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export interface AccountsRepo {
  getOwner(accountId: string): Promise<string | undefined>;
  /**
   * Returns the connected mailbox's own address (`Account.displayName` — e.g.
   * `demoalex775@gmail.com` for the Gmail channel). Used by `ApprovalService.approveDraft` to
   * determine the reply recipient correctly regardless of which participant a given message
   * tagged `from`/`to` (see the doc comment at that call site: some ingested records are the
   * account's own SENT mail replayed back through the pipeline, where naively trusting
   * `role === 'from'` would address the reply back to the account's own mailbox).
   */
  getOwnAddress(accountId: string): Promise<string | undefined>;

  /**
   * The connected-channels list for the connect-channel wizard (README L12, Task 8 brief
   * constraint 2). The accounts table has no GSI on `userId` (its only key is `accountId`) — at
   * demo scale (a handful of accounts total) a `Scan` with a server-side `FilterExpression` is the
   * pragmatic, deliberately-scoped choice over provisioning a new index for one low-traffic list
   * view. The filter runs IN DynamoDB, not after the fact in application code trusting the
   * caller — a user can never receive another user's account rows off the wire, satisfying the
   * same "server enforces scoping, never the client" rule every other read path in this file uses.
   * A production-scale version would add a `byUser` GSI instead; documented here as the deliberate
   * demo-scope tradeoff (mirrors `DataTables`'s own "demo-scoped choices" doc comment).
   */
  listByUser(userId: string): Promise<Account[]>;
}

export function createAccountsRepo(tableName: string): AccountsRepo {
  async function getAccount(accountId: string): Promise<Account | undefined> {
    const result = await client().send(
      new GetCommand({ TableName: tableName, Key: { accountId } }),
    );
    return result.Item as Account | undefined;
  }

  return {
    async getOwner(accountId) {
      const account = await getAccount(accountId);
      return account?.userId;
    },
    async getOwnAddress(accountId) {
      const account = await getAccount(accountId);
      return account?.displayName;
    },
    async listByUser(userId) {
      const result = await client().send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
        }),
      );
      return (result.Items ?? []) as Account[];
    },
  };
}

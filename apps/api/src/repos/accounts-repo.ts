import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
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
  };
}

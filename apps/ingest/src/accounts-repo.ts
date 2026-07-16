import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Account, ChannelType } from '@chief-of-staff/shared';

/**
 * Accounts table repository (design.md §5/§10, brief constraint 3/5). One item per connected
 * channel mailbox/number; the poller scans for active Gmail accounts each tick, and reads/writes
 * the `historyCursor` field that seeds the next incremental `history.list` call.
 *
 * `historyCursor` is additive to the shared `Account` shape (design.md's additive-field policy
 * for `NormalizedMessage` extends in spirit to this record too): it is Gmail-specific ingest
 * state, not part of the cross-channel `Account` contract in `packages/shared`, so it is kept as
 * a sibling field on the stored item rather than pushed into the shared schema.
 */
export interface StoredAccount extends Account {
  /** Gmail `historyId` cursor for incremental `history.list` polling; empty until first seed. */
  historyCursor?: string;
}

let cachedClient: DynamoDBDocumentClient | undefined;
function client(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export interface AccountsRepo {
  getAccount(accountId: string): Promise<StoredAccount | undefined>;
  listActiveAccountsByChannel(channelType: ChannelType): Promise<StoredAccount[]>;
  putAccount(account: StoredAccount): Promise<void>;
  updateHistoryCursor(accountId: string, historyCursor: string): Promise<void>;
}

export function createAccountsRepo(tableName: string): AccountsRepo {
  return {
    async getAccount(accountId) {
      const result = await client().send(new GetCommand({ TableName: tableName, Key: { accountId } }));
      return result.Item as StoredAccount | undefined;
    },

    async listActiveAccountsByChannel(channelType) {
      // Demo-scale table (a handful of connected accounts) — a filtered Scan is the
      // proportionate choice here rather than standing up a GSI for a query this infrequent
      // (one poller tick per minute) and this small.
      const result = await client().send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: 'channelType = :channelType',
          ExpressionAttributeValues: { ':channelType': channelType },
        }),
      );
      return (result.Items ?? []) as StoredAccount[];
    },

    async putAccount(account) {
      await client().send(new PutCommand({ TableName: tableName, Item: account }));
    },

    async updateHistoryCursor(accountId, historyCursor) {
      const existing = await client().send(new GetCommand({ TableName: tableName, Key: { accountId } }));
      if (!existing.Item) {
        throw new Error(`Cannot update historyCursor: account ${accountId} does not exist`);
      }
      await client().send(
        new PutCommand({
          TableName: tableName,
          Item: { ...(existing.Item as StoredAccount), historyCursor },
        }),
      );
    },
  };
}

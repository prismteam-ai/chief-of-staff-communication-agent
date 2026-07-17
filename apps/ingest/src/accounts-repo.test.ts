import { describe, expect, it, beforeEach } from 'vitest';

// The DynamoDBDocumentClient created inside accounts-repo.ts resolves region + credentials during
// command input marshalling even though aws-sdk-client-mock intercepts the actual network send —
// set fakes before anything in this file constructs a client (no real AWS call is ever made).
process.env.AWS_REGION ??= 'us-east-2';
process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { createAccountsRepo } from './accounts-repo.js';

// Must mock DynamoDBDocumentClient itself, not the underlying DynamoDBClient: with this SDK
// version, DynamoDBDocumentClient.from(base) does not route through the base client's patched
// `send`, so mocking the base class silently lets real requests through.
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('accounts-repo updateHistoryCursor', () => {
  it('issues a single UpdateCommand touching only historyCursor (no Get)', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createAccountsRepo('accounts-table');

    await repo.updateHistoryCursor('acct_1', '12345');

    const getCalls = ddbMock.commandCalls(GetCommand);
    const putCalls = ddbMock.commandCalls(PutCommand);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);

    expect(getCalls).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.args[0].input).toMatchObject({
      TableName: 'accounts-table',
      Key: { accountId: 'acct_1' },
      UpdateExpression: 'SET historyCursor = :historyCursor',
      ConditionExpression: 'attribute_exists(accountId)',
      ExpressionAttributeValues: { ':historyCursor': '12345' },
    });
  });

  it('propagates a ConditionalCheckFailedException when the account does not exist', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} }),
      );
    const repo = createAccountsRepo('accounts-table');

    await expect(repo.updateHistoryCursor('acct_missing', '999')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });
});

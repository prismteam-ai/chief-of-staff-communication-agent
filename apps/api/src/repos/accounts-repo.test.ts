import { describe, expect, it, beforeEach } from 'vitest';

// Same AWS SDK region/credential fake-out as communications-repo.test.ts — the
// DynamoDBDocumentClient created inside this module resolves region/credentials during command
// input marshalling even though aws-sdk-client-mock intercepts before any real network call.
process.env.AWS_REGION ??= 'us-east-2';
process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key';

import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { createAccountsRepo } from './accounts-repo.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const TABLE = 'chief-of-staff-accounts';

describe('accounts-repo.getOwner / getOwnAddress', () => {
  it('reads the account by GetCommand and returns userId / displayName', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        accountId: 'acct-1',
        userId: 'demo-alex',
        displayName: 'demoalex775@gmail.com',
        channelType: 'gmail',
        credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:123:secret:x',
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    });
    const repo = createAccountsRepo(TABLE);

    expect(await repo.getOwner('acct-1')).toBe('demo-alex');
    expect(await repo.getOwnAddress('acct-1')).toBe('demoalex775@gmail.com');
  });
});

describe('accounts-repo.listByUser — permission-boundary source for the connect-channel wizard', () => {
  it('issues a ScanCommand with a server-side FilterExpression on userId (DynamoDB applies the filter, not application code)', async () => {
    // DynamoDB itself applies FilterExpression before returning Items — the mock stands in for
    // "DynamoDB already filtered", so it resolves only the caller's own row. What this test proves
    // is that the REQUEST asks DynamoDB to filter by userId server-side, rather than scanning
    // everything and filtering in application code (which would mean the unfiltered rows briefly
    // left DynamoDB, an unnecessary widening of the data actually transmitted).
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          accountId: 'acct-a',
          userId: 'demo-alex',
          displayName: 'demoalex775@gmail.com',
          channelType: 'gmail',
          credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:123:secret:a',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      ],
    });
    const repo = createAccountsRepo(TABLE);

    const result = await repo.listByUser('demo-alex');

    expect(result).toHaveLength(1);
    expect(result[0]?.accountId).toBe('acct-a');
    const input = ddbMock.commandCalls(ScanCommand)[0]?.args[0].input;
    expect(input?.FilterExpression).toContain('userId');
    expect(input?.ExpressionAttributeValues?.[':userId']).toBe('demo-alex');
  });
});

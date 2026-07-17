import { describe, expect, it, beforeEach } from 'vitest';

// Same AWS SDK region/credential fake-out as apps/ingest/src/communications-repo.test.ts — the
// DynamoDBDocumentClient created inside this module resolves region/credentials during command
// input marshalling even though aws-sdk-client-mock intercepts before any real network call.
process.env.AWS_REGION ??= 'us-east-2';
process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { TransitionRecord } from '@chief-of-staff/shared';
import {
  createCommunicationsRepo,
  SendAlreadyClaimedError,
  TransitionConflictError,
} from './communications-repo.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const TABLE = 'chief-of-staff-communications';

function fixtureTransition(overrides: Partial<TransitionRecord> = {}): TransitionRecord {
  return {
    commId: 'gmail#abc123',
    accountId: 'acct-1',
    from: 'drafted',
    to: 'awaiting_approval',
    actorId: 'demo-alex',
    ts: '2026-07-16T18:00:00.000Z',
    ...overrides,
  };
}

describe('communications-repo.transition', () => {
  it('issues an UpdateCommand with a ConditionExpression asserting the from-state', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);

    await repo.transition(fixtureTransition());

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe('#status = :expectedFrom');
    expect(input?.ExpressionAttributeValues?.[':expectedFrom']).toBe('drafted');
    expect(input?.ExpressionAttributeValues?.[':status']).toBe('awaiting_approval');
  });

  it('throws TransitionConflictError when the conditional write fails (concurrent/duplicate writer)', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} }));
    const repo = createCommunicationsRepo(TABLE);

    await expect(repo.transition(fixtureTransition())).rejects.toThrow(TransitionConflictError);
  });

  it('merges an optional draft patch into the same update', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);

    await repo.transition(fixtureTransition({ from: 'edited', to: 'awaiting_approval' }), {
      draft: { commId: 'gmail#abc123', accountId: 'acct-1', body: 'edited body', confidence: 0.9 },
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toContain('draft = :draft');
    expect(input?.ExpressionAttributeValues?.[':draft']).toEqual({
      commId: 'gmail#abc123',
      accountId: 'acct-1',
      body: 'edited body',
      confidence: 0.9,
    });
  });
});

describe('communications-repo.transitionChain (final-review fix — multi-hop atomicity)', () => {
  it('issues exactly ONE UpdateCommand for a multi-hop chain, setting status straight to the LAST hop\'s "to"', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);
    const records = [
      fixtureTransition({ from: 'awaiting_approval', to: 'edited' }),
      fixtureTransition({ from: 'edited', to: 'awaiting_approval' }),
    ];

    await repo.transitionChain(records);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    // The item's `status` attribute is set straight to the chain's final state — the
    // intermediate `edited` value is never independently written as `status`.
    expect(input?.ExpressionAttributeValues?.[':status']).toBe('awaiting_approval');
    // But the FULL hop sequence is preserved in the audit trail.
    expect(input?.ExpressionAttributeValues?.[':newTransitions']).toEqual(records);
    // The condition still guards on the CHAIN'S starting state, not any intermediate hop.
    expect(input?.ConditionExpression).toBe('#status = :expectedFrom');
    expect(input?.ExpressionAttributeValues?.[':expectedFrom']).toBe('awaiting_approval');
  });

  it('throws TransitionConflictError (anchored on the FIRST hop) when the conditional write fails', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} }));
    const repo = createCommunicationsRepo(TABLE);
    const records = [
      fixtureTransition({ from: 'drafted', to: 'awaiting_approval' }),
      fixtureTransition({ from: 'awaiting_approval', to: 'rejected' }),
      fixtureTransition({ from: 'rejected', to: 'drafted' }),
    ];

    await expect(repo.transitionChain(records)).rejects.toThrow(TransitionConflictError);
    await expect(repo.transitionChain(records)).rejects.toMatchObject({ expectedFrom: 'drafted' });
  });

  it('merges an optional draft patch into the same single atomic write', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);
    const records = [
      fixtureTransition({ from: 'awaiting_approval', to: 'edited' }),
      fixtureTransition({ from: 'edited', to: 'awaiting_approval' }),
    ];

    await repo.transitionChain(records, {
      draft: { commId: 'gmail#abc123', accountId: 'acct-1', body: 'edited body', confidence: 0.9 },
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toContain('draft = :draft');
    expect(input?.ExpressionAttributeValues?.[':draft']).toEqual({
      commId: 'gmail#abc123',
      accountId: 'acct-1',
      body: 'edited body',
      confidence: 0.9,
    });
  });

  it('rejects a non-contiguous chain (hop N.to !== hop N+1.from) before ever calling DynamoDB', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);
    const records = [
      fixtureTransition({ from: 'awaiting_approval', to: 'edited' }),
      // Broken chain: this hop's `from` doesn't match the prior hop's `to`.
      fixtureTransition({ from: 'drafted', to: 'awaiting_approval' }),
    ];

    await expect(repo.transitionChain(records)).rejects.toThrow(/non-contiguous/);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('rejects an empty chain', async () => {
    const repo = createCommunicationsRepo(TABLE);
    await expect(repo.transitionChain([])).rejects.toThrow(
      'transitionChain requires at least one TransitionRecord',
    );
  });

  it('a single-record chain produces the IDENTICAL write `transition` produces (transition is a thin wrapper)', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);

    await repo.transition(fixtureTransition());

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues?.[':newTransitions']).toEqual([fixtureTransition()]);
    expect(input?.ExpressionAttributeValues?.[':status']).toBe('awaiting_approval');
  });
});

describe('communications-repo.claimSend — idempotency', () => {
  it('issues a conditional write requiring sendClaimedAt not already set', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);

    await repo.claimSend('gmail#abc123');

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe('attribute_not_exists(sendClaimedAt)');
  });

  it('throws SendAlreadyClaimedError on a second claim for the same communication', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'already claimed', $metadata: {} }));
    const repo = createCommunicationsRepo(TABLE);

    await expect(repo.claimSend('gmail#abc123')).rejects.toThrow(SendAlreadyClaimedError);
  });

  it('a retry claim (priorClaimedAt passed) CASes on the exact prior timestamp plus no sentMessageId', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);

    await repo.claimSend('gmail#abc123', '2026-07-16T16:35:41.893Z');

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe(
      'sendClaimedAt = :priorClaimedAt AND attribute_not_exists(sentMessageId)',
    );
    expect(input?.ExpressionAttributeValues?.[':priorClaimedAt']).toBe('2026-07-16T16:35:41.893Z');
  });

  it('throws SendAlreadyClaimedError when a retry claim loses its CAS (stale prior timestamp or already-sent)', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'CAS lost', $metadata: {} }));
    const repo = createCommunicationsRepo(TABLE);

    await expect(repo.claimSend('gmail#abc123', '2026-07-16T16:35:41.893Z')).rejects.toThrow(
      SendAlreadyClaimedError,
    );
  });
});

describe('communications-repo.recordSent', () => {
  it('sets sentMessageId via an UpdateCommand', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const repo = createCommunicationsRepo(TABLE);

    await repo.recordSent('gmail#abc123', 'provider-msg-99');

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues?.[':sentMessageId']).toBe('provider-msg-99');
  });
});

describe('communications-repo.listByAccount', () => {
  it('queries the byAccountStatus GSI scoped to the account, with an optional status filter', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const repo = createCommunicationsRepo(TABLE);

    await repo.listByAccount('acct-1', 'drafted');

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.IndexName).toBe('byAccountStatus');
    expect(input?.KeyConditionExpression).toContain('accountId = :accountId');
    expect(input?.KeyConditionExpression).toContain('#status = :status');
    expect(input?.ExpressionAttributeValues?.[':accountId']).toBe('acct-1');
    expect(input?.ExpressionAttributeValues?.[':status']).toBe('drafted');
  });

  it('omits the status condition when no status filter is given', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const repo = createCommunicationsRepo(TABLE);

    await repo.listByAccount('acct-1');

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.KeyConditionExpression).toBe('accountId = :accountId');
  });
});

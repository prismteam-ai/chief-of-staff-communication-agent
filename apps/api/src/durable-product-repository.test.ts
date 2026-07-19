import {
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type { DynamoApprovalExecutionRecords } from '@chief/approval-outbox/dynamo-execution-persistence';
import { PersistenceConflictError } from '@chief/persistence-dynamodb';

import {
  DynamoDurableProductRepository,
  MemoryDurableProductRepository,
  type AtomicApprovalWrite,
} from './durable-product-repository.js';

function approvalExecution(): DynamoApprovalExecutionRecords {
  return {
    locator: { PK: 'OPERATION#operation-1', SK: 'LOCATOR' },
    aggregate: {
      PK: 'OPERATION#operation-1',
      SK: 'AGGREGATE',
      operationId: 'operation-1',
    },
    authority: { PK: 'OPERATION#operation-1', SK: 'AUTHORITY' },
  } as unknown as DynamoApprovalExecutionRecords;
}

function approvalWrite(): AtomicApprovalWrite<{ readonly status: string }> {
  return {
    expectedDraftHead: {
      entityType: 'draft',
      entityId: 'draft-1',
      revisionId: 'draft-revision-1',
      version: 1,
    },
    proposal: {
      entityType: 'proposal',
      entityId: 'proposal-1',
      revisionId: 'proposal-1:approved',
      version: 2,
      expectedVersion: 1,
      expectedRevisionId: 'proposal-1:pending',
      committedAt: '2026-07-18T08:00:02.000Z',
      value: { status: 'approved' },
    },
    execution: approvalExecution(),
  };
}

async function seedApprovalPrerequisites(
  repository: MemoryDurableProductRepository,
): Promise<void> {
  await repository.putRevision('tenant-1', {
    entityType: 'draft',
    entityId: 'draft-1',
    revisionId: 'draft-revision-1',
    version: 1,
    committedAt: '2026-07-18T08:00:00.000Z',
    value: { body: 'Revision one' },
  });
  await repository.putRevision('tenant-1', {
    entityType: 'proposal',
    entityId: 'proposal-1',
    revisionId: 'proposal-1:pending',
    version: 1,
    committedAt: '2026-07-18T08:00:01.000Z',
    value: { status: 'pending_approval' },
  });
}

describe('MemoryDurableProductRepository replay contract', () => {
  it('accepts only an exact immutable revision replay', async () => {
    const repository = new MemoryDurableProductRepository();
    const write = {
      entityType: 'draft',
      entityId: 'draft-1',
      revisionId: 'draft-revision-1',
      version: 1,
      committedAt: '2026-07-18T08:00:00.000Z',
      value: { body: 'Persisted body', revision: 1 },
    };

    await expect(repository.putRevision('tenant-1', write)).resolves.toBe(
      'created',
    );
    await expect(repository.putRevision('tenant-1', write)).resolves.toBe(
      'duplicate',
    );
    await expect(
      Promise.resolve().then(() =>
        repository.putRevision('tenant-1', {
          ...write,
          value: { body: 'Conflicting body', revision: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
    await expect(
      repository.getCurrent('tenant-1', 'draft', 'draft-1'),
    ).resolves.toMatchObject({ value: write.value });
  });

  it('atomically advances a head with its exact immutable lookup', async () => {
    const repository = new MemoryDurableProductRepository();
    const input = {
      revision: {
        entityType: 'draft',
        entityId: 'draft-1',
        revisionId: 'draft-revision-1',
        version: 1,
        committedAt: '2026-07-18T08:00:00.000Z',
        value: { body: 'Persisted body', revision: 1 },
      },
      exactLookup: {
        entityType: 'draft-revision',
        entityId: 'draft-revision-1',
        revisionId: 'draft-revision-1',
        version: 1,
        committedAt: '2026-07-18T08:00:00.000Z',
        value: { body: 'Persisted body', revision: 1 },
      },
    };

    await expect(
      repository.putRevisionWithExactLookup('tenant-1', input),
    ).resolves.toBe('created');
    await expect(
      repository.putRevisionWithExactLookup('tenant-1', input),
    ).resolves.toBe('duplicate');
    await expect(
      repository.getExact('tenant-1', 'draft-revision', 'draft-revision-1'),
    ).resolves.toEqual(input.exactLookup);
    await expect(
      Promise.resolve().then(() =>
        repository.putRevisionWithExactLookup('tenant-1', {
          ...input,
          exactLookup: {
            ...input.exactLookup,
            value: { body: 'Conflicting body', revision: 1 },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
    await expect(
      repository.getCurrent('tenant-1', 'draft', 'draft-1'),
    ).resolves.toMatchObject({ value: input.revision.value });
  });

  it('conditions approval on the exact current draft head and remains idempotent', async () => {
    const repository = new MemoryDurableProductRepository();
    await seedApprovalPrerequisites(repository);
    const input = approvalWrite();

    await expect(repository.approveAtomically('tenant-1', input)).resolves.toBe(
      'created',
    );
    await expect(repository.approveAtomically('tenant-1', input)).resolves.toBe(
      'duplicate',
    );
    await expect(
      repository.getCurrent('tenant-1', 'proposal', 'proposal-1'),
    ).resolves.toMatchObject({ version: 2, value: { status: 'approved' } });
    expect(repository.executionRecord('operation-1')).toEqual(input.execution);
  });

  it('writes neither approval nor execution when the expected draft head is stale', async () => {
    const repository = new MemoryDurableProductRepository();
    await seedApprovalPrerequisites(repository);
    await repository.putRevision('tenant-1', {
      entityType: 'draft',
      entityId: 'draft-1',
      revisionId: 'draft-revision-2',
      version: 2,
      expectedVersion: 1,
      expectedRevisionId: 'draft-revision-1',
      committedAt: '2026-07-18T08:00:02.000Z',
      value: { body: 'Revision two' },
    });

    await expect(
      Promise.resolve().then(() =>
        repository.approveAtomically('tenant-1', approvalWrite()),
      ),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
    await expect(
      repository.getCurrent('tenant-1', 'proposal', 'proposal-1'),
    ).resolves.toMatchObject({
      version: 1,
      value: { status: 'pending_approval' },
    });
    expect(repository.executionRecord('operation-1')).toBeUndefined();
  });

  it('adds the exact draft-head condition to the Dynamo approval transaction', async () => {
    const send = vi.fn((_command: unknown) => Promise.resolve({}));
    const repository = new DynamoDurableProductRepository(
      { send } as unknown as DynamoDBDocumentClient,
      'chief-table',
    );

    await expect(
      repository.approveAtomically('tenant-1', approvalWrite()),
    ).resolves.toBe('created');
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    if (!(command instanceof TransactWriteCommand))
      throw new Error('TRANSACTION_NOT_CAPTURED');
    const transactionItems = command.input.TransactItems ?? [];
    expect(transactionItems).toHaveLength(6);
    const draftHeadCondition = transactionItems[0]?.ConditionCheck;
    expect(draftHeadCondition).toMatchObject({
      TableName: 'chief-table',
      ConditionExpression:
        '#tenant = :tenant AND #entityType = :entityType AND #entityId = :entityId AND #version = :version AND #revision = :revision AND #revisionSk = :revisionSk',
      ExpressionAttributeNames: {
        '#tenant': 'tenantId',
        '#entityType': 'entityType',
        '#entityId': 'entityId',
        '#version': 'version',
        '#revision': 'currentRevisionId',
        '#revisionSk': 'currentRevisionSk',
      },
      ExpressionAttributeValues: {
        ':tenant': 'tenant-1',
        ':entityType': 'draft',
        ':entityId': 'draft-1',
        ':version': 1,
        ':revision': 'draft-revision-1',
      },
    });
    expect(
      draftHeadCondition?.ExpressionAttributeValues?.[':revisionSk'],
    ).toEqual(expect.stringContaining('#REV#000000000001#'));
    expect(typeof draftHeadCondition?.Key?.['PK']).toBe('string');
    expect(typeof draftHeadCondition?.Key?.['SK']).toBe('string');
    expect(transactionItems[5]?.Update?.ConditionExpression).toBe(
      '#tenant = :tenant AND #version = :expectedVersion AND #revision = :expectedRevision',
    );
  });
});

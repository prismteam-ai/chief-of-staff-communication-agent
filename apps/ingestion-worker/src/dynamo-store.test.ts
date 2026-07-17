import { immutableBlobRefSchema, syncCheckpointSchema } from '@chief/contracts';
import type { DynamoPersistence } from '@chief/persistence-dynamodb';
import { describe, expect, it, vi } from 'vitest';

import { DynamoRepositoryIngestionStore } from './dynamo-store.js';
import type { CanonicalAsanaWrite, IngestionWorkItem } from './types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fixture(): {
  readonly workItem: IngestionWorkItem;
  readonly canonical: CanonicalAsanaWrite;
} {
  const checkpoint = syncCheckpointSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-a',
    accountId: 'asana-a',
    resourceScopeHash: HASH_A,
    kind: 'cursor',
    encryptedCursor: 'cursor-1',
    checkpointEpoch: 1,
    adapterVersion: '1',
    sourceWatermark: 'watermark-1',
    lastCompletePage: 0,
    status: 'active',
    committedAt: '2026-07-17T12:00:00.000Z',
  });
  const rawReference = immutableBlobRefSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-a',
    bucketRef: 'raw',
    objectKey: 'asana/task-1',
    objectVersion: HASH_A,
    contentHash: HASH_A,
    byteLength: 100,
    mediaType: 'application/json',
    encryptionKeyRef: 'fixture-kms',
    retentionPolicyVersion: '1',
  });
  return {
    workItem: {
      schemaVersion: '1',
      workItemId: 'work-asana-1',
      source: 'asana',
      tenantId: 'tenant-a',
      accountId: 'asana-a',
      connectorSnapshot: {
        connectorId: 'asana',
        descriptorVersion: '1',
        accountId:
          'asana-a' as IngestionWorkItem['connectorSnapshot']['accountId'],
        capabilitySnapshotHash: HASH_B,
        runtimeMode: 'fixture',
        selectionState: 'selected',
      },
      rawReference,
      record: {
        kind: 'asana',
        objectKind: 'task',
        providerObjectId: 'task-1',
        providerVersion: '1',
        providerTimestamp: '2026-07-17T12:01:00.000Z',
        payloadFingerprint: HASH_B,
        title: 'Project Atlas',
        projectIds: ['project-1'],
      },
      checkpoint: {
        current: checkpoint,
        nextEncryptedCursor: 'cursor-2',
        sourceWatermark: 'watermark-2',
        completePage: 1,
      },
      authorizationEpoch: 1,
      scopeHash: HASH_A,
    },
    canonical: {
      source: 'asana',
      dedupeKey: 'asana_dedupe_1',
      contentHash: HASH_B,
      tenantId: 'tenant-a',
      accountId: 'asana-a',
      objectKind: 'task',
      providerObjectId: 'task-1',
      providerVersion: '1',
      providerTimestamp: '2026-07-17T12:01:00.000Z',
      title: 'Project Atlas',
      projectIds: ['project-1'],
      topicTerms: ['atlas', 'project'],
      deleted: false,
    },
  };
}

describe('Dynamo repository ingestion adapter', () => {
  it('commits immutable fact/outbox before advancing the fenced checkpoint', async () => {
    const order: string[] = [];
    const putImmutableFactWithEvent = vi.fn(() => {
      order.push('canonical-and-event');
      return Promise.resolve();
    });
    const advanceCheckpoint = vi.fn(() => {
      order.push('checkpoint');
      return Promise.resolve();
    });
    const queryBounded = vi.fn(() => Promise.resolve([]));
    const persistence = {
      putImmutableFactWithEvent,
      advanceCheckpoint,
      queryBounded,
    } as unknown as DynamoPersistence;
    const bodyWriter = {
      put: vi.fn(() =>
        Promise.resolve(
          immutableBlobRefSchema.parse({
            schemaVersion: '1',
            tenantId: 'tenant-a',
            bucketRef: 'body',
            objectKey: 'body/a',
            objectVersion: HASH_A,
            contentHash: HASH_A,
            byteLength: 1,
            mediaType: 'text/plain',
            encryptionKeyRef: 'fixture-kms',
            retentionPolicyVersion: '1',
          }),
        ),
      ),
    };
    const store = new DynamoRepositoryIngestionStore({
      persistence,
      bodyWriter,
      coreTableName: 'core',
      connectorRuntimeTableName: 'runtime',
      threadLookupIndexName: 'thread-index',
      identityLookupIndexName: 'identity-index',
      asanaTopicLookupIndexName: 'asana-index',
    });
    const { workItem, canonical } = fixture();
    const nextCheckpoint = syncCheckpointSchema.parse({
      ...workItem.checkpoint?.current,
      encryptedCursor: 'cursor-2',
      checkpointEpoch: 2,
      sourceWatermark: 'watermark-2',
      lastCompletePage: 1,
      committedAt: '2026-07-17T12:02:00.000Z',
    });

    const result = await store.commit({
      workItem,
      canonical,
      checkpoint: nextCheckpoint,
    });

    expect(result).toEqual({ status: 'created' });
    expect(order).toEqual(['canonical-and-event', 'checkpoint']);
    expect(putImmutableFactWithEvent).toHaveBeenCalledOnce();
    expect(advanceCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCheckpointEpoch: 1,
        nextCheckpointEpoch: 2,
      }),
    );
  });
});

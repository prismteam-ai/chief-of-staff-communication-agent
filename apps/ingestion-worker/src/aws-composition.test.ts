import {
  connectorSnapshotSchema,
  immutableBlobRefSchema,
  retrievalScopeSchema,
  type ImmutableBlobRef,
} from '@chief/contracts';
import {
  BoundedRetrievalError,
  sha256Bytes,
  type ImmutableRetrievalArtifactStore,
} from '@chief/rag';
import { describe, expect, it } from 'vitest';

import { S3RetrievalMutationSink } from './aws-composition.js';
import type { CanonicalAsanaWrite, IngestionWorkItem } from './types.js';

class MemoryArtifacts implements ImmutableRetrievalArtifactStore {
  public puts = 0;

  public putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    this.puts += 1;
    const contentHash = sha256Bytes(input.bytes);
    return Promise.resolve(
      immutableBlobRefSchema.parse({
        schemaVersion: '1',
        tenantId: input.tenantId,
        bucketRef: 'fixture-artifacts',
        objectKey: `${input.namespace}/${input.scopeHash}/${contentHash}`,
        objectVersion: contentHash,
        contentHash,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        encryptionKeyRef: 'fixture-key',
        retentionPolicyVersion: '1',
      }),
    );
  }

  public getImmutableObject(): Promise<Uint8Array> {
    return Promise.reject(new Error('not required'));
  }
}

const scope = retrievalScopeSchema.parse({
  derivation: 'server_grants',
  tenantId: 'tenant-evaluator',
  accountIds: ['account-a', 'account-b'],
  brandIds: ['brand-a', 'brand-b'],
  authorizationEpoch: 1,
  scopeHash: 'a'.repeat(64),
  role: 'factual',
});

function fixture(overrides: Partial<IngestionWorkItem> = {}): {
  readonly workItem: IngestionWorkItem;
  readonly canonical: CanonicalAsanaWrite;
} {
  const rawReference = immutableBlobRefSchema.parse({
    schemaVersion: '1',
    tenantId: scope.tenantId,
    bucketRef: 'fixture-raw',
    objectKey: 'asana/task-1',
    objectVersion: 'b'.repeat(64),
    contentHash: 'b'.repeat(64),
    byteLength: 10,
    mediaType: 'application/json',
    encryptionKeyRef: 'fixture-key',
    retentionPolicyVersion: '1',
  });
  return {
    workItem: {
      schemaVersion: '1',
      workItemId: 'work-1',
      source: 'asana',
      tenantId: scope.tenantId,
      accountId: 'account-a',
      connectorSnapshot: connectorSnapshotSchema.parse({
        connectorId: 'asana',
        descriptorVersion: '1',
        accountId: 'account-a',
        capabilitySnapshotHash: 'c'.repeat(64),
        runtimeMode: 'fixture',
        selectionState: 'selected',
      }),
      rawReference,
      record: {
        kind: 'asana',
        objectKind: 'task',
        providerObjectId: 'task-1',
        providerVersion: '1',
        providerTimestamp: '2026-07-17T09:00:00.000Z',
        payloadFingerprint: 'd'.repeat(64),
        title: 'Synthetic task',
        projectIds: ['project-1'],
      },
      authorizationEpoch: scope.authorizationEpoch,
      scopeHash: scope.scopeHash,
      brandIds: ['brand-a'],
      ...overrides,
    },
    canonical: {
      source: 'asana',
      dedupeKey: 'asana-task-1',
      contentHash: 'e'.repeat(64),
      tenantId: scope.tenantId,
      accountId: 'account-a',
      objectKind: 'task',
      providerObjectId: 'task-1',
      providerVersion: '1',
      providerTimestamp: '2026-07-17T09:00:00.000Z',
      title: 'Synthetic task',
      projectIds: ['project-1'],
      topicTerms: ['synthetic', 'task'],
      deleted: false,
    },
  };
}

describe('S3 retrieval mutation scope authority', () => {
  it('uses the complete trusted scope while retaining item account provenance', async () => {
    const artifacts = new MemoryArtifacts();
    const input = fixture();
    const mutation = await new S3RetrievalMutationSink(
      artifacts,
      undefined,
      scope,
    ).stage(input);

    expect(mutation.scope).toEqual(scope);
    expect(mutation.scope.accountIds).toEqual(['account-a', 'account-b']);
    expect(artifacts.puts).toBe(1);
  });

  it('keeps the existing single-item scope when no trusted scope is supplied', async () => {
    const artifacts = new MemoryArtifacts();
    const mutation = await new S3RetrievalMutationSink(artifacts).stage(
      fixture(),
    );

    expect(mutation.scope).toEqual({
      ...scope,
      accountIds: ['account-a'],
      brandIds: ['brand-a'],
    });
  });

  it('rejects tenant, account, brand, epoch, and scope smuggling before writing', async () => {
    const cases: readonly Partial<IngestionWorkItem>[] = [
      { tenantId: 'tenant-rogue' },
      { accountId: 'account-rogue' },
      { brandIds: ['brand-rogue'] },
      { authorizationEpoch: 2 },
      { scopeHash: 'f'.repeat(64) },
    ];
    for (const overrides of cases) {
      const artifacts = new MemoryArtifacts();
      await expect(
        new S3RetrievalMutationSink(artifacts, undefined, scope).stage(
          fixture(overrides),
        ),
      ).rejects.toBeInstanceOf(BoundedRetrievalError);
      expect(artifacts.puts).toBe(0);
    }
  });
});

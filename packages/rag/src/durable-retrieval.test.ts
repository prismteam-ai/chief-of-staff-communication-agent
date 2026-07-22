import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  retrievalQuerySchema,
  retrievalScopeSchema,
  type RetrievalScope,
} from '@chief/contracts/knowledge';
import type { ImmutableBlobRef } from '@chief/contracts/storage';
import { immutableBlobRefSchema } from '@chief/contracts/storage';

import { BoundedDynamoS3RetrievalIndex } from './bounded-retrieval.js';
import {
  DeterministicEffectDisabledEmbedding,
  DurableRetrievalCompactor,
  canonicalJson,
  chiefRetrievalV1,
  listBoundedStagedRetrieval,
  persistEffectDisabledQueryVector,
  serializeBinary32Le,
  sha256Bytes,
  type DurableRetrievalHeadV1,
  type DurableRetrievalHeadStore,
  type ImmutableRetrievalArtifactStore,
  type PersistedQueryVectorStore,
  type ProjectionRecordV1,
  type StagedRetrievalMutationV1,
} from './durable-retrieval.js';

const scope = retrievalScopeSchema.parse({
  derivation: 'server_grants',
  tenantId: 'tenant-evaluator',
  accountIds: ['account-evaluator'],
  brandIds: ['brand-evaluator'],
  authorizationEpoch: 4,
  scopeHash: createHash('sha256').update('evaluator-scope').digest('hex'),
  role: 'factual',
});
const memory = { sample: () => ({ rssBytes: 1, limitBytes: 1_000_000 }) };

class MemoryDurableStore
  implements
    ImmutableRetrievalArtifactStore,
    DurableRetrievalHeadStore,
    PersistedQueryVectorStore
{
  public readonly objects = new Map<string, Uint8Array>();
  public readonly vectors = new Map<string, Float32Array>();
  public readonly heads = new Map<string, DurableRetrievalHeadV1>();
  public readonly authoritativeEpochs = new Map<string, number>();

  private domain(input: RetrievalScope): string {
    return `${input.tenantId}:${input.role}:${input.scopeHash}`;
  }

  public advanceAuthorizationEpoch(input: RetrievalScope): void {
    const key = this.domain(input);
    const current = this.authoritativeEpochs.get(key);
    if (current !== undefined && current > input.authorizationEpoch)
      throw new Error('stale authorization epoch');
    this.authoritativeEpochs.set(key, input.authorizationEpoch);
  }

  public getAuthorizationEpoch(input: RetrievalScope): number {
    return (
      this.authoritativeEpochs.get(this.domain(input)) ??
      input.authorizationEpoch
    );
  }

  public putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    const contentHash = sha256Bytes(input.bytes);
    const objectKey = `${input.namespace}/${input.scopeHash}/${contentHash}`;
    this.objects.set(objectKey, new Uint8Array(input.bytes));
    return Promise.resolve(
      immutableBlobRefSchema.parse({
        schemaVersion: '1',
        tenantId: input.tenantId,
        bucketRef: 'durable-retrieval',
        objectKey,
        objectVersion: contentHash,
        contentHash,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        encryptionKeyRef: 'test-kms-key',
        retentionPolicyVersion: '1',
      }),
    );
  }

  public getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array> {
    const value = this.objects.get(ref.objectKey);
    if (value === undefined) return Promise.reject(new Error('missing'));
    return Promise.resolve(new Uint8Array(value));
  }

  public getHead(
    input: RetrievalScope,
  ): Promise<DurableRetrievalHeadV1 | undefined> {
    const head = this.heads.get(this.domain(input));
    if (
      head !== undefined &&
      head.scope.authorizationEpoch > input.authorizationEpoch
    )
      return Promise.reject(new Error('stale authorization epoch'));
    return Promise.resolve(head);
  }

  public compareAndSwapHead(input: {
    readonly scope: RetrievalScope;
    readonly expectedManifestHash?: string;
    readonly next: DurableRetrievalHeadV1;
  }): Promise<'promoted' | 'stale'> {
    const key = this.domain(input.scope);
    const current = this.heads.get(key);
    const authoritativeEpoch = this.authoritativeEpochs.get(key);
    if (
      current?.manifest.manifestHash !== input.expectedManifestHash ||
      (authoritativeEpoch !== undefined &&
        authoritativeEpoch !== input.scope.authorizationEpoch)
    )
      return Promise.resolve('stale');
    if (authoritativeEpoch === undefined)
      this.authoritativeEpochs.set(key, input.scope.authorizationEpoch);
    this.heads.set(key, input.next);
    return Promise.resolve('promoted');
  }

  public putQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly vector: Float32Array;
  }): Promise<void> {
    this.vectors.set(
      `${canonicalJson(input.scope)}:${input.embeddingProfileManifestHash}:${input.queryHash}`,
      new Float32Array(input.vector),
    );
    return Promise.resolve();
  }

  public getQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly dimension: number;
  }): Promise<Float32Array | undefined> {
    const value = this.vectors.get(
      `${canonicalJson(input.scope)}:${input.embeddingProfileManifestHash}:${input.queryHash}`,
    );
    return Promise.resolve(value && new Float32Array(value));
  }
}

async function staged(input: {
  readonly store: MemoryDurableStore;
  readonly scope?: RetrievalScope;
  readonly ordinal?: string;
  readonly record?: ProjectionRecordV1;
  readonly operation?: 'upsert' | 'delete';
}): Promise<StagedRetrievalMutationV1> {
  const selectedScope = input.scope ?? scope;
  const ordinal =
    input.ordinal ??
    `2026-07-18T10:00:00.000Z#${sha256Bytes('work-item-apollo')}`;
  const record =
    input.record ??
    ({
      schemaVersion: '1',
      chunkId: 'chunk-apollo',
      sourceId: 'source-apollo',
      sourceVersion: '1',
      text: 'Apollo launch budget decision',
      tokenCount: 4,
      exactEntityRefs: ['thread-apollo'],
      citationLabel: 'Apollo evidence',
      contentHash: sha256Bytes('Apollo launch budget decision'),
      state: 'active',
      mutationOrdinal: ordinal,
    } satisfies ProjectionRecordV1);
  const operation = input.operation ?? 'upsert';
  const mutationRecord: ProjectionRecordV1 = {
    ...record,
    mutationOrdinal: ordinal,
    state: operation === 'upsert' ? 'active' : 'tombstoned',
  };
  const producer = new DeterministicEffectDisabledEmbedding();
  const document = {
    schemaVersion: '1',
    stagingOrdinal: ordinal,
    operation,
    record: mutationRecord,
    vectorBinary32LeBase64: Buffer.from(
      serializeBinary32Le(producer.embed(record.text)),
    ).toString('base64'),
  };
  const bytes = new TextEncoder().encode(JSON.stringify([document]));
  const object = await input.store.putImmutableObject({
    tenantId: selectedScope.tenantId,
    scopeHash: selectedScope.scopeHash,
    namespace: 'retrieval-staged',
    bytes,
    mediaType: 'application/vnd.chief.retrieval-staged+json;version=1',
  });
  return {
    contractVersion: chiefRetrievalV1.contractVersion,
    kind: 'staged-mutation',
    scope: selectedScope,
    mutationId: sha256Bytes(bytes),
    stagingOrdinal: ordinal,
    changeCount: 1,
    byteLength: bytes.byteLength,
    object,
    createdAt: ordinal.split('#')[0] as string,
  };
}

function compactor(store: MemoryDurableStore) {
  const producer = new DeterministicEffectDisabledEmbedding();
  return new DurableRetrievalCompactor({
    artifacts: store,
    heads: store,
    memory,
    embeddingProfileManifestHash: producer.profileManifestHash,
    embeddingProfileId: producer.profileId,
    vectorDimension: producer.dimension,
    now: () => new Date('2026-07-18T10:01:00.000Z'),
  });
}

function reader(input: { readonly store: MemoryDurableStore }) {
  return new BoundedDynamoS3RetrievalIndex({
    objects: input.store,
    memory,
    clock: { now: () => new Date('2026-07-18T10:01:30.000Z') },
    authority: {
      getSnapshotHead: async (requested) =>
        (await input.store.getHead(requested))?.manifest,
      getAuthorizationEpoch: (requested) =>
        Promise.resolve(input.store.getAuthorizationEpoch(requested)),
      queryDeltas: () => Promise.resolve({ manifests: [] }),
      getExactChunkIds: () => Promise.reject(new Error('must not be called')),
      hydrateAuthorization: () =>
        Promise.reject(new Error('must not be called')),
      getQueryVector: async (query) => {
        const value = await input.store.getQueryVector(query);
        if (value === undefined) throw new Error('missing vector');
        return value;
      },
    },
  });
}

describe('chief-retrieval.v1 durable compaction', () => {
  it('enumerates registered staging through bounded deterministic pages', async () => {
    const store = new MemoryDurableStore();
    const first = await staged({ store });
    const second = await staged({
      store,
      ordinal: `2026-07-18T10:00:01.000Z#${sha256Bytes('work-item-two')}`,
      record: {
        schemaVersion: '1',
        chunkId: 'chunk-two',
        sourceId: 'source-two',
        sourceVersion: '1',
        text: 'Apollo launch budget decision',
        tokenCount: 4,
        exactEntityRefs: ['thread-two'],
        citationLabel: 'Second evidence',
        contentHash: sha256Bytes('Apollo launch budget decision'),
        state: 'active',
        mutationOrdinal: 'overridden-by-helper',
      },
    });
    const pages = [
      { manifests: [first], nextToken: first.mutationId },
      { manifests: [second] },
    ];
    let page = 0;
    await expect(
      listBoundedStagedRetrieval({
        scope,
        catalog: {
          listStaged: () => Promise.resolve(pages[page++] ?? { manifests: [] }),
        },
      }),
    ).resolves.toEqual([first, second]);
  });

  it('promotes production-shaped staging into the exact bounded reader snapshot and query-vector path', async () => {
    const store = new MemoryDurableStore();
    const mutation = await staged({ store });
    const result = await compactor(store).compactAndPromote({
      scope,
      staged: [mutation, mutation],
    });
    expect(result).toMatchObject({
      status: 'promoted',
      replayedMutationCount: 1,
      duplicateMutationCount: 1,
      head: {
        generation: 1,
        publishedSequenceStart: 1,
        publishedSequenceEnd: 1,
        manifest: { chunkCount: 1, vectorFormat: 'binary32-le-row-major' },
      },
    });
    expect(mutation).not.toHaveProperty('sequence');

    const producer = new DeterministicEffectDisabledEmbedding();
    const queryVector = await persistEffectDisabledQueryVector({
      store,
      producer,
      scope,
      queryText: 'Apollo budget',
    });
    const record: ProjectionRecordV1 = {
      schemaVersion: '1',
      chunkId: 'chunk-apollo',
      sourceId: 'source-apollo',
      sourceVersion: '1',
      text: 'Apollo launch budget decision',
      tokenCount: 4,
      exactEntityRefs: ['thread-apollo'],
      citationLabel: 'Apollo evidence',
      contentHash: sha256Bytes('Apollo launch budget decision'),
      state: 'active',
      mutationOrdinal: mutation.stagingOrdinal,
    };
    const index = reader({ store });
    await expect(index.health(scope)).resolves.toMatchObject({
      status: 'healthy',
      indexedChunkCount: 1,
      activeGeneration: 1,
    });
    const query = retrievalQuerySchema.parse({
      schemaVersion: '1',
      scope,
      queryText: 'Apollo budget',
      exactEntityRefs: [],
      limit: 5,
      embeddingProfileManifestHash: producer.profileManifestHash,
      queryHash: queryVector.queryHash,
    });
    const response = await index.queryWithCitations(query);
    expect(response.abstained).toBe(false);
    expect(response.candidates.map(({ chunkId }) => chunkId)).toEqual([
      'chunk-apollo',
    ]);
    expect(response.citations).toHaveLength(1);
    expect(response.evidence).toEqual([
      expect.objectContaining({
        chunkId: record.chunkId,
        text: record.text,
      }),
    ]);
  });

  it('never reports readable health until a validated head exists', async () => {
    const store = new MemoryDurableStore();
    await expect(reader({ store }).health(scope)).resolves.toMatchObject({
      status: 'unavailable',
      reasonCode: 'ACCESS_DENIED',
    });
  });

  it('rejects stale writers and cross-tenant staged mutations', async () => {
    const store = new MemoryDurableStore();
    const mutation = await staged({ store });
    const first = await compactor(store).compactAndPromote({
      scope,
      staged: [mutation],
    });
    await expect(
      compactor(store).compactAndPromote({ scope, staged: [mutation] }),
    ).rejects.toMatchObject({ code: 'INDEX_REFRESH_REQUIRED' });
    const retry = await compactor(store).compactAndPromote({
      scope,
      staged: [mutation],
      expectedHeadManifestHash: first.head.manifest.manifestHash,
    });
    expect(retry).toMatchObject({
      status: 'unchanged',
      appliedMutationCount: 0,
      head: {
        publishedSequenceEnd: first.head.publishedSequenceEnd,
        manifest: { manifestHash: first.head.manifest.manifestHash },
      },
    });

    const otherScope = retrievalScopeSchema.parse({
      ...scope,
      tenantId: 'tenant-other',
      scopeHash: sha256Bytes('other-scope'),
    });
    const foreign = await staged({ store, scope: otherScope });
    await expect(
      compactor(store).compactAndPromote({
        scope,
        staged: [foreign],
        expectedHeadManifestHash: first.head.manifest.manifestHash,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('keeps a promoted tombstone authoritative over replayed older upserts', async () => {
    const store = new MemoryDurableStore();
    const upsert = await staged({ store });
    const initial = await compactor(store).compactAndPromote({
      scope,
      staged: [upsert],
    });
    const deletion = await staged({
      store,
      operation: 'delete',
      ordinal: `2026-07-18T10:02:00.000Z#${sha256Bytes('delete-apollo')}`,
    });
    const deleted = await compactor(store).compactAndPromote({
      scope,
      staged: [deletion],
      expectedHeadManifestHash: initial.head.manifest.manifestHash,
    });
    expect(deleted.head.publishedSequenceEnd).toBe(2);
    const replay = await compactor(store).compactAndPromote({
      scope,
      staged: [upsert],
      expectedHeadManifestHash: deleted.head.manifest.manifestHash,
    });
    expect(replay).toMatchObject({
      status: 'unchanged',
      appliedMutationCount: 0,
      head: { publishedSequenceEnd: 2 },
    });
    const producer = new DeterministicEffectDisabledEmbedding();
    const vector = await persistEffectDisabledQueryVector({
      store,
      producer,
      scope,
      queryText: 'Apollo budget',
    });
    await expect(
      reader({ store }).queryWithCitations(
        retrievalQuerySchema.parse({
          schemaVersion: '1',
          scope,
          queryText: 'Apollo budget',
          exactEntityRefs: ['thread-apollo'],
          limit: 5,
          embeddingProfileManifestHash: producer.profileManifestHash,
          queryHash: vector.queryHash,
        }),
      ),
    ).resolves.toMatchObject({
      abstained: true,
      candidates: [],
      citations: [],
      evidence: [],
    });
  });

  it('denies old-epoch reads, promotes a fresh epoch, and fences stale writers', async () => {
    const store = new MemoryDurableStore();
    store.advanceAuthorizationEpoch(scope);
    const oldMutation = await staged({ store });
    const oldHead = await compactor(store).compactAndPromote({
      scope,
      staged: [oldMutation],
    });
    const producer = new DeterministicEffectDisabledEmbedding();
    const oldVector = await persistEffectDisabledQueryVector({
      store,
      producer,
      scope,
      queryText: 'Apollo budget',
    });
    const oldQuery = retrievalQuerySchema.parse({
      schemaVersion: '1',
      scope,
      queryText: 'Apollo budget',
      exactEntityRefs: [],
      limit: 5,
      embeddingProfileManifestHash: producer.profileManifestHash,
      queryHash: oldVector.queryHash,
    });
    await expect(
      reader({ store }).queryWithCitations(oldQuery),
    ).resolves.toMatchObject({ abstained: false });

    const nextScope = retrievalScopeSchema.parse({
      ...scope,
      authorizationEpoch: scope.authorizationEpoch + 1,
    });
    store.advanceAuthorizationEpoch(nextScope);
    await expect(
      reader({ store }).queryWithCitations(oldQuery),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    const nextMutation = await staged({
      store,
      scope: nextScope,
      ordinal: `2026-07-18T10:05:00.000Z#${sha256Bytes('epoch-five')}`,
      record: {
        schemaVersion: '1',
        chunkId: 'chunk-epoch-five',
        sourceId: 'source-epoch-five',
        sourceVersion: '1',
        text: 'Apollo budget authorized only in epoch five',
        tokenCount: 7,
        exactEntityRefs: ['thread-epoch-five'],
        citationLabel: 'Epoch five evidence',
        contentHash: sha256Bytes('Apollo budget authorized only in epoch five'),
        state: 'active',
        mutationOrdinal: 'overridden-by-helper',
      },
    });
    const nextHead = await compactor(store).compactAndPromote({
      scope: nextScope,
      staged: [nextMutation],
      expectedHeadManifestHash: oldHead.head.manifest.manifestHash,
    });
    expect(nextHead).toMatchObject({
      status: 'promoted',
      head: {
        generation: 2,
        scope: { authorizationEpoch: nextScope.authorizationEpoch },
      },
    });
    const nextVector = await persistEffectDisabledQueryVector({
      store,
      producer,
      scope: nextScope,
      queryText: 'Apollo budget',
    });
    const nextResult = await reader({ store }).queryWithCitations(
      retrievalQuerySchema.parse({
        ...oldQuery,
        scope: nextScope,
        queryHash: nextVector.queryHash,
      }),
    );
    expect(nextResult).toMatchObject({
      abstained: false,
      authorizationEpoch: 5,
    });
    expect(nextResult.candidates.map(({ chunkId }) => chunkId)).toEqual([
      'chunk-epoch-five',
    ]);
    expect(nextResult.evidence.map(({ chunkId }) => chunkId)).toEqual([
      'chunk-epoch-five',
    ]);
    expect(nextResult.candidates.map(({ chunkId }) => chunkId)).not.toContain(
      'chunk-apollo',
    );
    expect(() => store.advanceAuthorizationEpoch(scope)).toThrow(
      'stale authorization epoch',
    );
    await expect(
      compactor(store).compactAndPromote({
        scope,
        staged: [oldMutation],
        expectedHeadManifestHash: nextHead.head.manifest.manifestHash,
      }),
    ).rejects.toThrow('stale authorization epoch');
  });

  it('rejects corrupted staging and hard item bounds before promotion', async () => {
    const store = new MemoryDurableStore();
    const mutation = await staged({ store });
    store.objects.set(
      mutation.object.objectKey,
      new TextEncoder().encode('[{"tampered":true}]'),
    );
    await expect(
      compactor(store).compactAndPromote({ scope, staged: [mutation] }),
    ).rejects.toMatchObject({ code: 'CORRUPT_SNAPSHOT' });

    await expect(
      compactor(new MemoryDurableStore()).compactAndPromote({
        scope,
        staged: Array.from(
          { length: chiefRetrievalV1.maximumStagedMutations + 1 },
          () => mutation,
        ),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('enforces aggregate staged-byte and RSS memory bounds', async () => {
    const store = new MemoryDurableStore();
    const mutation = await staged({ store });
    const oversized = Array.from({ length: 17 }, (_, index) => ({
      ...mutation,
      mutationId: sha256Bytes(`oversized-${String(index)}`),
      byteLength: 4 * 1024 * 1024,
      object: { ...mutation.object, byteLength: 4 * 1024 * 1024 },
    }));
    await expect(
      compactor(store).compactAndPromote({ scope, staged: oversized }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });

    const producer = new DeterministicEffectDisabledEmbedding();
    const memoryBound = new DurableRetrievalCompactor({
      artifacts: store,
      heads: store,
      memory: { sample: () => ({ rssBytes: 600, limitBytes: 1_000 }) },
      embeddingProfileManifestHash: producer.profileManifestHash,
      embeddingProfileId: producer.profileId,
      vectorDimension: producer.dimension,
    });
    await expect(
      memoryBound.compactAndPromote({ scope, staged: [mutation] }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });
});

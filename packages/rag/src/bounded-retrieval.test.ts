import { createHash } from 'node:crypto';

import {
  retrievalDeltaManifestSchema,
  retrievalQuerySchema,
  retrievalScopeSchema,
  retrievalSnapshotManifestSchema,
  type RetrievalDeltaManifest,
  type RetrievalScope,
  type RetrievalSnapshotManifest,
} from '@chief/contracts/knowledge';
import type { ImmutableBlobRef } from '@chief/contracts/storage';
import { describe, expect, it } from 'vitest';

import {
  BoundedDynamoS3RetrievalIndex,
  assertBoundedAggregate,
  bm25Scores,
  decodeBinary32Vectors,
  exhaustiveCosine,
  frozenScoringProfile,
  hashManifest,
  tokenize,
  type AuthorizationHydration,
  type BoundedRetrievalError,
  type DeltaPage,
  type RetrievalAuthorityReader,
  type SnapshotObjectReader,
} from './bounded-retrieval.js';
import type { RetrievalIndex } from './index.js';

const sha = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const tenantId = 'tenant-alpha';
const scopeHash = sha('tenant-alpha/factual/accounts/a/brands/b');
const profileHash = sha('embedding-profile-v1');
const now = '2026-07-17T12:00:00.000Z';

const scope = retrievalScopeSchema.parse({
  derivation: 'server_grants',
  tenantId,
  accountIds: ['account-a'],
  brandIds: ['brand-a'],
  authorizationEpoch: 1,
  scopeHash,
  role: 'factual',
});

interface FixtureRecord {
  readonly schemaVersion: '1';
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly text: string;
  readonly tokenCount: number;
  readonly exactEntityRefs: readonly string[];
}

const records: readonly FixtureRecord[] = [
  {
    schemaVersion: '1' as const,
    chunkId: 'chunk-apollo',
    sourceId: 'source-apollo',
    sourceVersion: '3',
    text: 'Apollo launch budget approval and active Asana milestone',
    tokenCount: 8,
    exactEntityRefs: ['asana-task-12001', 'thread-apollo'],
  },
  {
    schemaVersion: '1' as const,
    chunkId: 'chunk-hiring',
    sourceId: 'source-hiring',
    sourceVersion: '2',
    text: 'Quarterly hiring plan and recruiting update',
    tokenCount: 6,
    exactEntityRefs: ['asana-task-12002'],
  },
  {
    schemaVersion: '1' as const,
    chunkId: 'chunk-revoked',
    sourceId: 'source-revoked',
    sourceVersion: '1',
    text: 'Apollo confidential acquisition budget',
    tokenCount: 4,
    exactEntityRefs: ['asana-task-secret'],
  },
].sort((left, right) =>
  Buffer.compare(Buffer.from(left.chunkId), Buffer.from(right.chunkId)),
);

const vectorById: Readonly<Record<string, readonly number[]>> = {
  'chunk-apollo': [1, 0],
  'chunk-hiring': [0, 1],
  'chunk-revoked': [0.99, 0.01],
};

function vectorBytes(rows: readonly (readonly number[])[]): Uint8Array {
  const bytes = new Uint8Array(rows.length * 2 * 4);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, rowIndex) =>
    row.forEach((value, columnIndex) =>
      view.setFloat32((rowIndex * 2 + columnIndex) * 4, value, true),
    ),
  );
  return bytes;
}

function blob(
  name: string,
  bytes: Uint8Array,
  mediaType: string,
): ImmutableBlobRef {
  const contentHash = sha256Bytes(bytes);
  return {
    schemaVersion: '1',
    tenantId: tenantId as ImmutableBlobRef['tenantId'],
    bucketRef: 'chief-retrieval-snapshots',
    objectKey: `retrieval/${scopeHash}/${contentHash}/${name}`,
    objectVersion: 'fixture-version-1',
    contentHash,
    byteLength: bytes.byteLength,
    mediaType,
    encryptionKeyRef: 'alias/chief-product',
    retentionPolicyVersion: '1',
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class FixtureObjects implements SnapshotObjectReader {
  public readonly reads: string[] = [];
  public constructor(public readonly objects = new Map<string, Uint8Array>()) {}
  public getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array> {
    this.reads.push(ref.objectKey);
    const value = this.objects.get(ref.objectKey);
    if (!value) throw new Error('fixture object missing');
    return Promise.resolve(value.slice());
  }
}

class FixtureAuthority implements RetrievalAuthorityReader {
  public scans = 0;
  public exactLookups = 0;
  public epoch = 1;
  public epochReads = 0;
  public pages: readonly DeltaPage[] = [{ manifests: [] }];
  public hydration = new Map<string, AuthorizationHydration>();
  public head!: RetrievalSnapshotManifest;

  public getSnapshotHead(
    input: RetrievalScope,
  ): Promise<RetrievalSnapshotManifest | undefined> {
    return Promise.resolve(input.tenantId === tenantId ? this.head : undefined);
  }
  public getAuthorizationEpoch(_scope: RetrievalScope): Promise<number> {
    this.epochReads += 1;
    return Promise.resolve(this.epoch);
  }
  public queryDeltas(input: {
    readonly pageToken?: string;
  }): Promise<DeltaPage> {
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return Promise.resolve(this.pages[index] ?? { manifests: [] });
  }
  public getExactChunkIds(input: {
    readonly exactEntityRefs: readonly string[];
  }): Promise<readonly string[]> {
    this.exactLookups += 1;
    const refs = new Set(input.exactEntityRefs);
    return Promise.resolve(
      records
        .filter((record) => record.exactEntityRefs.some((ref) => refs.has(ref)))
        .map((record) => record.chunkId),
    );
  }
  public hydrateAuthorization(input: {
    readonly chunkIds: readonly string[];
  }): Promise<readonly AuthorizationHydration[]> {
    return Promise.resolve(
      input.chunkIds.flatMap((id) => {
        const value = this.hydration.get(id);
        return value ? [value] : [];
      }),
    );
  }
  public getQueryVector(input: {
    readonly dimension: number;
  }): Promise<Float32Array> {
    expect(input.dimension).toBe(2);
    return Promise.resolve(new Float32Array([1, 0]));
  }
}

function buildFixture(): {
  readonly index: BoundedDynamoS3RetrievalIndex;
  readonly authority: FixtureAuthority;
  readonly objects: FixtureObjects;
  readonly manifest: RetrievalSnapshotManifest;
} {
  const projectionBytes = new TextEncoder().encode(
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  const vectors = vectorBytes(
    records.map((record) => vectorById[record.chunkId] as readonly number[]),
  );
  const projectionRef = blob(
    'chunk-projection.jsonl',
    projectionBytes,
    'application/x-ndjson',
  );
  const vectorRef = blob('vectors.f32le', vectors, 'application/octet-stream');
  const objects = new FixtureObjects(
    new Map([
      [projectionRef.objectKey, projectionBytes],
      [vectorRef.objectKey, vectors],
    ]),
  );
  const base = {
    schemaVersion: '1' as const,
    tenantId,
    role: 'factual' as const,
    scopeHash,
    generation: 7,
    authorizationEpoch: 1,
    sourceWatermark: '000000000000042',
    embeddingProfileManifestHash: profileHash,
    vectorDimension: 2,
    normalizationVersion: 'l2-v1',
    lexicalScoringVersion: frozenScoringProfile.version,
    vectorFormat: 'binary32-le-row-major' as const,
    shards: [
      {
        chunkIdObject: projectionRef,
        vectorObject: vectorRef,
        chunkCount: records.length,
        decodedBytes: projectionBytes.byteLength + vectors.byteLength,
      },
    ],
    sourceCount: records.length,
    chunkCount: records.length,
    serializedBytes: projectionBytes.byteLength + vectors.byteLength,
    decodedBytes: projectionBytes.byteLength + vectors.byteLength,
    manifestHash: '0'.repeat(64),
    createdAt: now,
  };
  const manifest = retrievalSnapshotManifestSchema.parse({
    ...base,
    manifestHash: hashManifest(base as RetrievalSnapshotManifest),
  });
  const authority = new FixtureAuthority();
  authority.head = manifest;
  for (const record of records) {
    authority.hydration.set(record.chunkId, {
      chunkId: record.chunkId,
      state: record.chunkId === 'chunk-revoked' ? 'tombstoned' : 'active',
      sourceVersion: record.sourceVersion,
      citationLabel: record.sourceId.replace('source-', 'Evidence: '),
      contentHash: sha(record.text),
    });
  }
  const index = new BoundedDynamoS3RetrievalIndex({
    authority,
    objects,
    memory: { sample: () => ({ rssBytes: 100, limitBytes: 1_000 }) },
    clock: { now: () => new Date(now) },
  });
  return { index, authority, objects, manifest };
}

function query(overrides: Record<string, unknown> = {}) {
  return retrievalQuerySchema.parse({
    schemaVersion: '1',
    scope,
    queryText: 'Apollo launch budget',
    exactEntityRefs: [],
    limit: 10,
    embeddingProfileManifestHash: profileHash,
    queryHash: sha('Apollo launch budget/vector-v1'),
    ...overrides,
  });
}

function addDelta(
  fixture: ReturnType<typeof buildFixture>,
  change: Record<string, unknown>,
): RetrievalDeltaManifest {
  const bytes = new TextEncoder().encode(JSON.stringify([change]));
  const ref = blob('delta-1.json', bytes, 'application/json');
  fixture.objects.objects.set(ref.objectKey, bytes);
  const base = {
    schemaVersion: '1' as const,
    tenantId,
    role: 'factual' as const,
    scopeHash,
    baseGeneration: fixture.manifest.generation,
    authorizationEpoch: 1,
    sequenceStart: 1,
    sequenceEnd: 1,
    changeCount: 1,
    byteLength: bytes.byteLength,
    object: ref,
    manifestHash: '0'.repeat(64),
    createdAt: now,
  };
  const manifest = retrievalDeltaManifestSchema.parse({
    ...base,
    manifestHash: hashManifest(base as RetrievalDeltaManifest),
  });
  fixture.authority.pages = [{ manifests: [manifest] }];
  return manifest;
}

describe('bounded DynamoDB/S3 retrieval', () => {
  it('implements the frozen RetrievalIndex without a mutation or Scan surface', () => {
    const fixture = buildFixture();
    expect(fixture.index satisfies RetrievalIndex).toBe(fixture.index);
    expect(
      Object.getOwnPropertyNames(
        Object.getPrototypeOf(fixture.authority) as object,
      ).some((key) => /^(scan|put|update)/iu.test(key)),
    ).toBe(false);
    expect(
      typeof (fixture.index as unknown as Record<string, unknown>).publish,
    ).toBe('undefined');
  });

  it('uses real tokenization, BM25 corpus statistics, and document-length normalization', () => {
    expect(tokenize("Apollo's BUDGET — Q3")).toEqual([
      "apollo's",
      'budget',
      'q3',
    ]);
    const scores = bm25Scores(
      ['apollo', 'budget'],
      [
        tokenize('apollo budget'),
        tokenize('apollo budget budget budget'),
        tokenize('hiring plan'),
      ],
    );
    expect(scores[0]).toBeCloseTo(1.047096, 5);
    expect(scores[1]).toBeCloseTo(1.057294, 5);
    expect(scores[2]).toBe(0);
  });

  it('decodes deterministic binary32 and preserves Node exhaustive-cosine score parity', () => {
    const encoded = vectorBytes([
      [1, 0],
      [0.6, 0.8],
    ]);
    const decoded = decodeBinary32Vectors(encoded, 2, 2);
    expect([...(decoded[1] as Float32Array)]).toEqual([
      Math.fround(0.6),
      Math.fround(0.8),
    ]);
    expect(exhaustiveCosine(new Float32Array([1, 0]), decoded)).toEqual([
      1,
      Math.fround(0.6),
    ]);
  });

  it('fuses exact, lexical, and vector evidence and emits only currently authorized citations', async () => {
    const fixture = buildFixture();
    const result = await fixture.index.queryWithCitations(
      query({ exactEntityRefs: ['asana-task-12001'] }),
    );
    expect(result.abstained).toBe(false);
    expect(result.candidates.map((candidate) => candidate.chunkId)).toEqual([
      'chunk-apollo',
    ]);
    expect(typeof result.candidates[0]?.lexicalScore).toBe('number');
    expect(result.candidates[0]).toMatchObject({
      vectorScore: 1,
      authorizationEpoch: 1,
    });
    expect(result.citations.map((citation) => citation.chunkId)).toEqual([
      'chunk-apollo',
    ]);
    expect(fixture.authority.exactLookups).toBe(1);
    expect(JSON.stringify(result)).not.toContain('revoked');
  });

  it('supports exact, lexical, vector, and fusion golden ablations', () => {
    const lexical = bm25Scores(
      tokenize('apollo budget'),
      records.map((record) => tokenize(record.text)),
    );
    const vector = exhaustiveCosine(
      new Float32Array([1, 0]),
      records.map(
        (record) =>
          new Float32Array(vectorById[record.chunkId] as readonly number[]),
      ),
    );
    const exact = records.map((record) =>
      record.exactEntityRefs.includes('asana-task-12002') ? 1 : 0,
    );
    expect(records[lexical.indexOf(Math.max(...lexical))]?.chunkId).toBe(
      'chunk-revoked',
    );
    expect(records[vector.indexOf(Math.max(...vector))]?.chunkId).toBe(
      'chunk-apollo',
    );
    expect(records[exact.indexOf(1)]?.chunkId).toBe('chunk-hiring');
    expect(frozenScoringProfile).toEqual({
      version: 'chief-bounded-fusion-v1',
      bm25K1: 1.2,
      bm25B: 0.75,
      lexicalWeight: 0.45,
      vectorWeight: 0.4,
      exactWeight: 0.15,
      abstentionThreshold: 0.25,
    });
  });

  it('reconstructs snapshot plus a binary-vector delta deterministically', async () => {
    const fixture = buildFixture();
    const deltaRecord: FixtureRecord = {
      schemaVersion: '1',
      chunkId: 'chunk-apollo-followup',
      sourceId: 'source-apollo-followup',
      sourceVersion: '1',
      text: 'Apollo budget follow-up decision',
      tokenCount: 5,
      exactEntityRefs: ['thread-apollo'],
    };
    addDelta(fixture, {
      schemaVersion: '1',
      sequence: 1,
      operation: 'upsert',
      record: deltaRecord,
      vectorBinary32LeBase64: Buffer.from(vectorBytes([[0.8, 0.2]])).toString(
        'base64',
      ),
    });
    fixture.authority.hydration.set(deltaRecord.chunkId, {
      chunkId: deltaRecord.chunkId,
      state: 'active',
      sourceVersion: '1',
      citationLabel: 'Apollo follow-up',
      contentHash: sha(deltaRecord.text),
    });
    const inspection = await fixture.index.inspect(scope);
    expect(inspection).toMatchObject({
      chunkCount: 3,
      pendingDeltaCount: 0,
      generation: 7,
    });
    const result = await fixture.index.queryWithCitations(query());
    expect(result.candidates.map((candidate) => candidate.chunkId)).toContain(
      'chunk-apollo-followup',
    );
  });

  it('abstains without exposing a denied candidate count or ordering', async () => {
    const fixture = buildFixture();
    for (const record of records)
      fixture.authority.hydration.set(record.chunkId, {
        chunkId: record.chunkId,
        state: 'denied',
      });
    await expect(
      fixture.index.queryWithCitations(query()),
    ).resolves.toMatchObject({
      abstained: true,
      candidates: [],
      citations: [],
    });
  });

  it('fails closed on cross-tenant scope and profile mismatch', async () => {
    const fixture = buildFixture();
    const otherScope = retrievalScopeSchema.parse({
      ...scope,
      tenantId: 'tenant-beta',
    });
    await expect(
      fixture.index.query(query({ scope: otherScope })),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(
      fixture.index.query(
        query({ embeddingProfileManifestHash: sha('wrong-profile') }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY_PROFILE' });

    fixture.authority.getExactChunkIds = () =>
      Promise.resolve(['chunk-from-another-scope']);
    await expect(
      fixture.index.query(
        query({ exactEntityRefs: ['asana-task-from-another-scope'] }),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('fails closed at shard, serialized-size, and delta hard limits', async () => {
    const tooManyShards = buildFixture();
    const shard = tooManyShards.manifest.shards[0];
    if (!shard) throw new Error('fixture shard missing');
    const overShardedBase = {
      ...tooManyShards.manifest,
      shards: [shard, shard, shard, shard, shard],
      chunkCount: shard.chunkCount * 5,
      manifestHash: '0'.repeat(64),
    };
    tooManyShards.authority.head = {
      ...overShardedBase,
      manifestHash: hashManifest(overShardedBase),
    };
    await expect(tooManyShards.index.query(query())).rejects.toMatchObject({
      code: 'CORRUPT_SNAPSHOT',
    });

    const tooLarge = buildFixture();
    const tooLargeBase = {
      ...tooLarge.manifest,
      serializedBytes: 64 * 1024 * 1024 + 1,
      manifestHash: '0'.repeat(64),
    };
    tooLarge.authority.head = {
      ...tooLargeBase,
      manifestHash: hashManifest(tooLargeBase),
    };
    await expect(tooLarge.index.query(query())).rejects.toMatchObject({
      code: 'CORRUPT_SNAPSHOT',
    });

    const tooManyDeltas = buildFixture();
    const delta = addDelta(tooManyDeltas, {
      schemaVersion: '1',
      sequence: 1,
      operation: 'delete',
      chunkId: 'chunk-hiring',
    });
    const deltaBase = {
      ...delta,
      changeCount: 257,
      manifestHash: '0'.repeat(64),
    };
    tooManyDeltas.authority.pages = [
      {
        manifests: [
          {
            ...deltaBase,
            manifestHash: hashManifest(deltaBase),
          },
        ],
      },
    ];
    await expect(tooManyDeltas.index.query(query())).rejects.toMatchObject({
      code: 'INDEX_REFRESH_REQUIRED',
    });
  });

  it('validates applyDelta parsed count and exact sequence boundaries', async () => {
    const fixture = buildFixture();
    const delta = addDelta(fixture, {
      schemaVersion: '1',
      sequence: 1,
      operation: 'delete',
      chunkId: 'chunk-hiring',
    });
    const incompleteBase = {
      ...delta,
      changeCount: 2,
      sequenceEnd: 2,
      manifestHash: '0'.repeat(64),
    };
    const incomplete = {
      ...incompleteBase,
      manifestHash: hashManifest(incompleteBase),
    };
    await expect(fixture.index.applyDelta(incomplete)).rejects.toMatchObject({
      code: 'INDEX_REFRESH_REQUIRED',
      message: 'INDEX_REFRESH_REQUIRED',
    });

    const wrongStartFixture = buildFixture();
    const wrongStart = addDelta(wrongStartFixture, {
      schemaVersion: '1',
      sequence: 2,
      operation: 'delete',
      chunkId: 'chunk-hiring',
    });
    await expect(
      wrongStartFixture.index.applyDelta(wrongStart),
    ).rejects.toMatchObject({ code: 'INDEX_REFRESH_REQUIRED' });
  });

  it('enforces aggregate snapshot plus delta serialized and decoded limits', () => {
    expect(() =>
      assertBoundedAggregate({
        snapshotSerializedBytes: 64 * 1024 * 1024 - 10,
        deltaSerializedBytes: 11,
        snapshotDecodedBytes: 1,
        deltaDecodedBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INDEX_REFRESH_REQUIRED' }));
    expect(() =>
      assertBoundedAggregate({
        snapshotSerializedBytes: 1,
        deltaSerializedBytes: 1,
        snapshotDecodedBytes: 128 * 1024 * 1024 - 4,
        deltaDecodedBytes: 5,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INDEX_REFRESH_REQUIRED' }));
  });

  it('denies stale projected text when authoritative version or content hash differs', async () => {
    const staleVersion = buildFixture();
    const current = staleVersion.authority.hydration.get('chunk-apollo');
    if (!current) throw new Error('fixture hydration missing');
    staleVersion.authority.hydration.set('chunk-apollo', {
      ...current,
      sourceVersion: '4',
    });
    await expect(
      staleVersion.index.queryWithCitations(query()),
    ).resolves.toMatchObject({
      abstained: true,
      candidates: [],
      citations: [],
    });

    const staleContent = buildFixture();
    const content = staleContent.authority.hydration.get('chunk-apollo');
    if (!content) throw new Error('fixture hydration missing');
    staleContent.authority.hydration.set('chunk-apollo', {
      ...content,
      contentHash: sha('new authoritative text'),
    });
    await expect(
      staleContent.index.queryWithCitations(query()),
    ).resolves.toMatchObject({
      abstained: true,
      candidates: [],
      citations: [],
    });
  });

  it('normalizes snapshot and delta object-reader failures without leaking details', async () => {
    const snapshotFailure = buildFixture();
    snapshotFailure.objects.getImmutableObject = () =>
      Promise.reject(new Error('s3://private-bucket/tenant/object-key'));
    await expect(snapshotFailure.index.query(query())).rejects.toMatchObject({
      code: 'CORRUPT_SNAPSHOT',
      message: 'CORRUPT_SNAPSHOT',
    });

    const deltaFailure = buildFixture();
    const delta = addDelta(deltaFailure, {
      schemaVersion: '1',
      sequence: 1,
      operation: 'delete',
      chunkId: 'chunk-hiring',
    });
    deltaFailure.objects.objects.delete(delta.object.objectKey);
    await expect(deltaFailure.index.applyDelta(delta)).rejects.toMatchObject({
      code: 'INDEX_REFRESH_REQUIRED',
      message: 'INDEX_REFRESH_REQUIRED',
    });
  });

  it('strictly rejects malformed delete/tombstone delta shapes and public inputs', async () => {
    const extraField = buildFixture();
    const extraDelta = addDelta(extraField, {
      schemaVersion: '1',
      sequence: 1,
      operation: 'delete',
      chunkId: 'chunk-hiring',
      providerMetadata: 'must-not-pass',
    });
    await expect(extraField.index.applyDelta(extraDelta)).rejects.toMatchObject(
      {
        code: 'INDEX_REFRESH_REQUIRED',
      },
    );

    const invalidId = buildFixture();
    const invalidDelta = addDelta(invalidId, {
      schemaVersion: '1',
      sequence: 1,
      operation: 'tombstone',
      chunkId: '',
    });
    await expect(
      invalidId.index.applyDelta(invalidDelta),
    ).rejects.toMatchObject({
      code: 'INDEX_REFRESH_REQUIRED',
    });

    const malformed = buildFixture();
    await expect(
      malformed.index.applySnapshot({} as unknown as RetrievalSnapshotManifest),
    ).rejects.toMatchObject({ code: 'CORRUPT_SNAPSHOT' });
    await expect(
      malformed.index.query({} as unknown as ReturnType<typeof query>),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY_PROFILE' });
  });

  it('fails closed on corrupt objects, incomplete pagination, RSS, and epoch races', async () => {
    const corrupt = buildFixture();
    const firstKey = corrupt.manifest.shards[0]?.chunkIdObject
      .objectKey as string;
    corrupt.objects.objects.set(
      firstKey,
      new TextEncoder().encode('tampered\n'),
    );
    await expect(corrupt.index.query(query())).rejects.toMatchObject({
      code: 'CORRUPT_SNAPSHOT',
    });

    const paginated = buildFixture();
    paginated.authority.pages = [
      { manifests: [], nextToken: '1' },
      { manifests: [], nextToken: '2' },
      { manifests: [], nextToken: '3' },
      { manifests: [], nextToken: '4' },
      { manifests: [] },
    ];
    await expect(paginated.index.query(query())).rejects.toMatchObject({
      code: 'INDEX_REFRESH_REQUIRED',
    });

    const rssFixture = buildFixture();
    const rssIndex = new BoundedDynamoS3RetrievalIndex({
      authority: rssFixture.authority,
      objects: rssFixture.objects,
      memory: { sample: () => ({ rssBytes: 600, limitBytes: 1_000 }) },
    });
    await expect(rssIndex.query(query())).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
    });

    const epochRace = buildFixture();
    const originalEpoch = epochRace.authority.getAuthorizationEpoch.bind(
      epochRace.authority,
    );
    epochRace.authority.getAuthorizationEpoch = async (input) => {
      const value = await originalEpoch(input);
      if (epochRace.authority.epochReads >= 2) epochRace.authority.epoch += 1;
      return value;
    };
    await expect(epochRace.index.query(query())).rejects.toEqual(
      expect.objectContaining<Partial<BoundedRetrievalError>>({
        code: 'ACCESS_DENIED',
      }),
    );
  });

  it('performs read-only inspection with no cache dependency across tenants', async () => {
    const fixture = buildFixture();
    const first = await fixture.index.inspect(scope);
    const second = await fixture.index.inspect(scope);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ chunkCount: 2, pendingDeltaCount: 0 });
    await expect(fixture.index.health(scope)).resolves.toMatchObject({
      status: 'healthy',
      indexedChunkCount: 2,
      pendingDeltaCount: 0,
    });
    expect(fixture.objects.reads).toHaveLength(6);
    expect(fixture.authority.scans).toBe(0);
  });
});

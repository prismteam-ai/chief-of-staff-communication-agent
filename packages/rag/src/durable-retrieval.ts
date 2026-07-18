import { createHash } from 'node:crypto';

import {
  chunkIdSchema,
  sha256Schema,
  sourceIdSchema,
  timestampSchema,
} from '@chief/contracts/ids';
import {
  retrievalScopeSchema,
  retrievalSnapshotManifestSchema,
  type RetrievalScope,
  type RetrievalSnapshotManifest,
} from '@chief/contracts/knowledge';
import {
  immutableBlobRefSchema,
  type ImmutableBlobRef,
} from '@chief/contracts/storage';

import {
  BoundedDynamoS3RetrievalIndex,
  BoundedRetrievalError,
  decodeBinary32Vectors,
  hashManifest,
  parseProjectionSourceAuthority,
  readProjectionRecords,
  tokenize,
  type MemoryProbe,
  type ProjectionSourceAuthority,
  type SnapshotObjectReader,
} from './bounded-retrieval.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const STAGING_ORDINAL =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z#[a-f0-9]{64}$/u;

export const chiefRetrievalV1 = Object.freeze({
  contractVersion: 'chief-retrieval.v1',
  keyContractVersion: 'chief-retrieval-key.v1',
  vectorFormat: 'binary32-le-row-major',
  deterministicEmbeddingProfileId: 'chief-effect-disabled-hash-v1',
  deterministicEmbeddingDimension: 32,
  maximumStagedMutations: 10_000,
  maximumStagedBytes: 64 * 1024 * 1024,
  maximumSnapshotChunks: 10_000,
  maximumSnapshotBytes: 64 * 1024 * 1024,
  maximumDecodedBytes: 128 * 1024 * 1024,
} as const);

export interface ProjectionRecordV1 {
  readonly schemaVersion: '1';
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly text: string;
  readonly tokenCount: number;
  readonly exactEntityRefs: readonly string[];
  readonly citationLabel: string;
  readonly contentHash: string;
  readonly state: 'active' | 'tombstoned';
  readonly mutationOrdinal: string;
  /** Omitted only while reading a legacy pre-authority staged record. */
  readonly sourceAuthority?: ProjectionSourceAuthority;
}

export interface StagedUpsertV1 {
  readonly schemaVersion: '1';
  readonly stagingOrdinal: string;
  readonly operation: 'upsert';
  readonly record: ProjectionRecordV1;
  readonly vectorBinary32LeBase64: string;
}

export interface StagedDeleteV1 {
  readonly schemaVersion: '1';
  readonly stagingOrdinal: string;
  readonly operation: 'delete' | 'tombstone';
  readonly record: ProjectionRecordV1;
  readonly vectorBinary32LeBase64: string;
}

export type StagedMutationDocumentV1 = StagedUpsertV1 | StagedDeleteV1;

export interface StagedRetrievalMutationV1 {
  readonly contractVersion: 'chief-retrieval.v1';
  readonly kind: 'staged-mutation';
  readonly scope: RetrievalScope;
  readonly mutationId: string;
  readonly stagingOrdinal: string;
  readonly changeCount: 1;
  readonly byteLength: number;
  readonly object: ImmutableBlobRef;
  readonly createdAt: string;
}

export interface DurableRetrievalHeadV1 {
  readonly contractVersion: 'chief-retrieval.v1';
  readonly kind: 'snapshot-head';
  readonly scope: RetrievalScope;
  readonly generation: number;
  readonly publishedSequenceStart: number;
  readonly publishedSequenceEnd: number;
  readonly manifest: RetrievalSnapshotManifest;
  readonly promotedAt: string;
}

export interface EffectDisabledEmbeddingProducer {
  readonly profileId: string;
  readonly profileManifestHash: string;
  readonly dimension: number;
  embed(text: string): Float32Array;
}

export interface ImmutableRetrievalArtifactStore extends SnapshotObjectReader {
  putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef>;
}

export interface DurableRetrievalHeadStore {
  getHead(scope: RetrievalScope): Promise<DurableRetrievalHeadV1 | undefined>;
  compareAndSwapHead(input: {
    readonly scope: RetrievalScope;
    readonly expectedManifestHash?: string;
    readonly next: DurableRetrievalHeadV1;
  }): Promise<'promoted' | 'stale'>;
}

export interface PersistedQueryVectorStore {
  putQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly vector: Float32Array;
  }): Promise<void>;
  getQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly dimension: number;
  }): Promise<Float32Array | undefined>;
}

export interface RetrievalStagingRegistrar {
  register(manifest: StagedRetrievalMutationV1): Promise<void>;
}

export interface StagedRetrievalPageV1 {
  readonly manifests: readonly StagedRetrievalMutationV1[];
  readonly nextToken?: string;
}

export interface RetrievalStagingCatalog {
  listStaged(input: {
    readonly scope: RetrievalScope;
    readonly limit: number;
    readonly nextToken?: string;
  }): Promise<StagedRetrievalPageV1>;
}

export async function listBoundedStagedRetrieval(input: {
  readonly catalog: RetrievalStagingCatalog;
  readonly scope: RetrievalScope;
}): Promise<readonly StagedRetrievalMutationV1[]> {
  const scope = retrievalScopeSchema.parse(input.scope);
  const manifests: StagedRetrievalMutationV1[] = [];
  const tokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const result = await input.catalog.listStaged({
      scope,
      limit: 256,
      ...(nextToken === undefined ? {} : { nextToken }),
    });
    for (const candidate of result.manifests) {
      const manifest = validateStagedRetrievalMutation(candidate);
      if (!sameScope(manifest.scope, scope))
        throw new BoundedRetrievalError('ACCESS_DENIED');
      manifests.push(manifest);
      if (manifests.length > chiefRetrievalV1.maximumStagedMutations)
        throw new BoundedRetrievalError('RESOURCE_LIMIT');
    }
    if (result.nextToken === undefined) return Object.freeze(manifests);
    if (tokens.has(result.nextToken) || result.manifests.length === 0)
      fail('INDEX_REFRESH_REQUIRED');
    tokens.add(result.nextToken);
    nextToken = result.nextToken;
  }
  throw new BoundedRetrievalError('RESOURCE_LIMIT');
}

export type SnapshotValidator = (
  scope: RetrievalScope,
  manifest: RetrievalSnapshotManifest,
) => Promise<void>;

export interface DurableRetrievalCompactorOptions {
  readonly artifacts: ImmutableRetrievalArtifactStore;
  readonly heads: DurableRetrievalHeadStore;
  readonly memory: MemoryProbe;
  readonly embeddingProfileManifestHash: string;
  readonly embeddingProfileId: string;
  readonly vectorDimension: number;
  readonly normalizationVersion?: string;
  readonly now?: () => Date;
  readonly validateSnapshot?: SnapshotValidator;
}

export interface CompactionResult {
  readonly status: 'promoted' | 'unchanged';
  readonly replayedMutationCount: number;
  readonly appliedMutationCount: number;
  readonly duplicateMutationCount: number;
  readonly head: DurableRetrievalHeadV1;
}

function fail(code: 'CORRUPT_SNAPSHOT' | 'INDEX_REFRESH_REQUIRED'): never {
  throw new BoundedRetrievalError(code);
}

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const RETRIEVAL_INTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/u;

function retrievalKeyPart(value: string): string {
  if (!RETRIEVAL_INTERNAL_ID.test(value))
    throw new BoundedRetrievalError('ACCESS_DENIED');
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Secret-independent durable retrieval key contract. Canonical ingestion keys
 * remain secret-backed; retrieval producers and readers use this exact seam.
 */
export function retrievalDynamoKeyV1(
  scope: RetrievalScope,
  entityId: string,
): Readonly<{ PK: string; SK: string }> {
  const safe = retrievalScopeSchema.parse(scope);
  const separator = entityId.indexOf(':');
  const sortKey =
    separator > 0 && separator < entityId.length - 1
      ? `I#${retrievalKeyPart(entityId.slice(0, separator))}#V#${retrievalKeyPart(entityId.slice(separator + 1))}`
      : `I#${retrievalKeyPart(entityId)}`;
  return Object.freeze({
    PK: `T#${retrievalKeyPart(safe.tenantId)}#R#${retrievalKeyPart(safe.role)}#S#${retrievalKeyPart(safe.scopeHash)}`,
    SK: sortKey,
  });
}

export function retrievalDynamoEntityPrefixV1(
  scope: RetrievalScope,
  entityKind: string,
): Readonly<{ PK: string; SKPrefix: string }> {
  const key = retrievalDynamoKeyV1(scope, `${entityKind}:x`);
  return Object.freeze({
    PK: key.PK,
    SKPrefix: key.SK.slice(0, key.SK.lastIndexOf('#') + 1),
  });
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function sameScope(left: RetrievalScope, right: RetrievalScope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameRetrievalDomain(
  left: RetrievalScope,
  right: RetrievalScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.scopeHash === right.scopeHash &&
    left.role === right.role
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertMemory(memory: MemoryProbe): void {
  const sample = memory.sample();
  if (
    !Number.isFinite(sample.rssBytes) ||
    !Number.isFinite(sample.limitBytes) ||
    sample.rssBytes < 0 ||
    sample.limitBytes <= 0 ||
    sample.rssBytes / sample.limitBytes >= 0.6
  )
    throw new BoundedRetrievalError('RESOURCE_LIMIT');
}

function assertObject(
  ref: ImmutableBlobRef,
  bytes: Uint8Array,
  scope: RetrievalScope,
): void {
  if (
    ref.tenantId !== scope.tenantId ||
    ref.byteLength !== bytes.byteLength ||
    ref.contentHash !== sha256Bytes(bytes) ||
    !ref.objectKey.includes(scope.scopeHash) ||
    !ref.objectKey.includes(ref.contentHash) ||
    ref.objectKey.includes('..')
  )
    fail('CORRUPT_SNAPSHOT');
}

export function parseProjectionRecordV1(value: unknown): ProjectionRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INDEX_REFRESH_REQUIRED');
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      'schemaVersion',
      'chunkId',
      'sourceId',
      'sourceVersion',
      'text',
      'tokenCount',
      'exactEntityRefs',
      'citationLabel',
      'contentHash',
      'state',
      'mutationOrdinal',
      ...(record.sourceAuthority === undefined ? [] : ['sourceAuthority']),
    ]) ||
    record.schemaVersion !== '1' ||
    !chunkIdSchema.safeParse(record.chunkId).success ||
    !sourceIdSchema.safeParse(record.sourceId).success ||
    typeof record.sourceVersion !== 'string' ||
    record.sourceVersion.length === 0 ||
    typeof record.text !== 'string' ||
    !Number.isSafeInteger(record.tokenCount) ||
    (record.tokenCount as number) < 0 ||
    tokenize(record.text).length !== record.tokenCount ||
    !Array.isArray(record.exactEntityRefs) ||
    record.exactEntityRefs.length > 100 ||
    record.exactEntityRefs.some(
      (entry) => typeof entry !== 'string' || entry.length === 0,
    ) ||
    typeof record.citationLabel !== 'string' ||
    record.citationLabel.length === 0 ||
    !sha256Schema.safeParse(record.contentHash).success ||
    record.contentHash !== sha256Bytes(record.text) ||
    !['active', 'tombstoned'].includes(record.state as string) ||
    typeof record.mutationOrdinal !== 'string' ||
    !STAGING_ORDINAL.test(record.mutationOrdinal)
  )
    fail('INDEX_REFRESH_REQUIRED');
  return Object.freeze({
    schemaVersion: '1',
    chunkId: record.chunkId as string,
    sourceId: record.sourceId as string,
    sourceVersion: record.sourceVersion,
    text: record.text,
    tokenCount: record.tokenCount,
    exactEntityRefs: Object.freeze([...(record.exactEntityRefs as string[])]),
    citationLabel: record.citationLabel,
    contentHash: record.contentHash,
    state: record.state as 'active' | 'tombstoned',
    mutationOrdinal: record.mutationOrdinal,
    sourceAuthority: parseProjectionSourceAuthority(record.sourceAuthority),
  });
}

function canonicalBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    fail('INDEX_REFRESH_REQUIRED');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('INDEX_REFRESH_REQUIRED');
  return bytes;
}

export function serializeBinary32Le(vector: Float32Array): Uint8Array {
  if (vector.length === 0) fail('INDEX_REFRESH_REQUIRED');
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  let magnitude = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] as number;
    if (!Number.isFinite(value)) fail('INDEX_REFRESH_REQUIRED');
    magnitude += value * value;
    view.setFloat32(index * 4, value, true);
  }
  if (magnitude === 0) fail('INDEX_REFRESH_REQUIRED');
  return bytes;
}

export function parseStagedMutationObject(
  bytes: Uint8Array,
  expectedOrdinal: string,
  dimension: number,
): StagedMutationDocumentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    fail('INDEX_REFRESH_REQUIRED');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1)
    fail('INDEX_REFRESH_REQUIRED');
  const raw: unknown = (parsed as readonly unknown[])[0];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    fail('INDEX_REFRESH_REQUIRED');
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== '1' ||
    value.stagingOrdinal !== expectedOrdinal ||
    !STAGING_ORDINAL.test(expectedOrdinal)
  )
    fail('INDEX_REFRESH_REQUIRED');
  if (['upsert', 'delete', 'tombstone'].includes(value.operation as string)) {
    if (
      !exactKeys(value, [
        'schemaVersion',
        'stagingOrdinal',
        'operation',
        'record',
        'vectorBinary32LeBase64',
      ]) ||
      typeof value.vectorBinary32LeBase64 !== 'string'
    )
      fail('INDEX_REFRESH_REQUIRED');
    const binary = canonicalBase64(value.vectorBinary32LeBase64);
    decodeBinary32Vectors(binary, 1, dimension);
    const parsedRecord = parseProjectionRecordV1(value.record);
    if (
      parsedRecord.mutationOrdinal !== expectedOrdinal ||
      (value.operation === 'upsert' && parsedRecord.state !== 'active') ||
      (value.operation !== 'upsert' && parsedRecord.state !== 'tombstoned')
    )
      fail('INDEX_REFRESH_REQUIRED');
    return Object.freeze({
      schemaVersion: '1',
      stagingOrdinal: expectedOrdinal,
      operation: value.operation as 'upsert' | 'delete' | 'tombstone',
      record: parsedRecord,
      vectorBinary32LeBase64: value.vectorBinary32LeBase64,
    });
  }
  fail('INDEX_REFRESH_REQUIRED');
}

export function validateStagedRetrievalMutation(
  value: unknown,
): StagedRetrievalMutationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INDEX_REFRESH_REQUIRED');
  const manifest = value as Record<string, unknown>;
  if (
    !exactKeys(manifest, [
      'contractVersion',
      'kind',
      'scope',
      'mutationId',
      'stagingOrdinal',
      'changeCount',
      'byteLength',
      'object',
      'createdAt',
    ]) ||
    manifest.contractVersion !== chiefRetrievalV1.contractVersion ||
    manifest.kind !== 'staged-mutation' ||
    !retrievalScopeSchema.safeParse(manifest.scope).success ||
    !sha256Schema.safeParse(manifest.mutationId).success ||
    typeof manifest.stagingOrdinal !== 'string' ||
    !STAGING_ORDINAL.test(manifest.stagingOrdinal) ||
    manifest.changeCount !== 1 ||
    !Number.isSafeInteger(manifest.byteLength) ||
    (manifest.byteLength as number) < 1 ||
    (manifest.byteLength as number) > 4 * 1024 * 1024 ||
    !timestampSchema.safeParse(manifest.createdAt).success ||
    manifest.createdAt !== manifest.stagingOrdinal.split('#')[0]
  )
    fail('INDEX_REFRESH_REQUIRED');
  const object = immutableBlobRefSchema.safeParse(manifest.object);
  if (!object.success || object.data.byteLength !== manifest.byteLength)
    fail('INDEX_REFRESH_REQUIRED');
  return Object.freeze({
    contractVersion: chiefRetrievalV1.contractVersion,
    kind: 'staged-mutation',
    scope: retrievalScopeSchema.parse(manifest.scope),
    mutationId: sha256Schema.parse(manifest.mutationId),
    stagingOrdinal: manifest.stagingOrdinal,
    changeCount: 1,
    byteLength: Number(manifest.byteLength),
    object: object.data,
    createdAt: timestampSchema.parse(manifest.createdAt),
  });
}

export class DeterministicEffectDisabledEmbedding implements EffectDisabledEmbeddingProducer {
  public readonly profileId = chiefRetrievalV1.deterministicEmbeddingProfileId;
  public readonly dimension = chiefRetrievalV1.deterministicEmbeddingDimension;
  public readonly profileManifestHash = sha256Bytes(
    `${this.profileId}:${this.dimension}:binary32-le`,
  );

  public embed(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    const tokens = tokenize(text);
    const features = tokens.length === 0 ? [text.normalize('NFKC')] : tokens;
    for (const token of features) {
      const digest = createHash('sha256').update(token, 'utf8').digest();
      const index = digest.readUInt32LE(0) % this.dimension;
      const sign = (digest[4] as number) % 2 === 0 ? 1 : -1;
      vector[index] = Math.fround((vector[index] as number) + sign);
    }
    let magnitude = 0;
    for (const value of vector) magnitude += value * value;
    if (magnitude === 0) vector[0] = 1;
    else {
      const denominator = Math.sqrt(magnitude);
      for (let index = 0; index < vector.length; index += 1)
        vector[index] = Math.fround((vector[index] as number) / denominator);
    }
    return vector;
  }
}

export function queryVectorHash(
  queryText: string,
  embeddingProfileManifestHash: string,
): string {
  return sha256Bytes(
    `chief-retrieval-query\u00001\u0000${embeddingProfileManifestHash}\u0000${queryText.normalize('NFKC')}`,
  );
}

export function prepareEffectDisabledQueryVector(input: {
  readonly producer: EffectDisabledEmbeddingProducer;
  readonly queryText: string;
}): {
  readonly queryHash: string;
  readonly embeddingProfileManifestHash: string;
  readonly vector: Float32Array;
} {
  const queryHash = queryVectorHash(
    input.queryText,
    input.producer.profileManifestHash,
  );
  return Object.freeze({
    queryHash,
    embeddingProfileManifestHash: input.producer.profileManifestHash,
    vector: input.producer.embed(input.queryText),
  });
}

export async function persistEffectDisabledQueryVector(input: {
  readonly store: PersistedQueryVectorStore;
  readonly producer: EffectDisabledEmbeddingProducer;
  readonly scope: RetrievalScope;
  readonly queryText: string;
}): Promise<{ readonly queryHash: string; readonly vector: Float32Array }> {
  const scope = retrievalScopeSchema.parse(input.scope);
  const prepared = prepareEffectDisabledQueryVector(input);
  await input.store.putQueryVector({
    scope,
    ...prepared,
  });
  return Object.freeze({
    queryHash: prepared.queryHash,
    vector: new Float32Array(prepared.vector),
  });
}

function serializeProjection(
  records: readonly ProjectionRecordV1[],
): Uint8Array {
  if (records.length === 0) return new Uint8Array();
  return encoder.encode(
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

function serializeVectors(vectors: readonly Float32Array[]): Uint8Array {
  const bytes = new Uint8Array(
    vectors.reduce((sum, vector) => sum + vector.byteLength, 0),
  );
  let offset = 0;
  for (const vector of vectors) {
    const encoded = serializeBinary32Le(vector);
    bytes.set(encoded, offset);
    offset += encoded.byteLength;
  }
  return bytes;
}

function vectorsEqual(left: Float32Array, right: Float32Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

async function readBaseRecords(input: {
  readonly scope: RetrievalScope;
  readonly head?: DurableRetrievalHeadV1;
  readonly artifacts: ImmutableRetrievalArtifactStore;
  readonly dimension: number;
}): Promise<Map<string, { record: ProjectionRecordV1; vector: Float32Array }>> {
  const output = new Map<
    string,
    { record: ProjectionRecordV1; vector: Float32Array }
  >();
  if (input.head === undefined) return output;
  const manifest = retrievalSnapshotManifestSchema.parse(input.head.manifest);
  if (
    !sameScope(input.head.scope, input.scope) ||
    manifest.manifestHash !== hashManifest(manifest) ||
    manifest.vectorDimension !== input.dimension
  )
    fail('CORRUPT_SNAPSHOT');
  for (const shard of manifest.shards) {
    const [recordBytes, vectorBytes] = await Promise.all([
      input.artifacts.getImmutableObject(shard.chunkIdObject),
      input.artifacts.getImmutableObject(shard.vectorObject),
    ]);
    assertObject(shard.chunkIdObject, recordBytes, input.scope);
    assertObject(shard.vectorObject, vectorBytes, input.scope);
    const records = readProjectionRecords(recordBytes);
    const vectors = decodeBinary32Vectors(
      vectorBytes,
      shard.chunkCount,
      input.dimension,
    );
    if (records.length !== vectors.length) fail('CORRUPT_SNAPSHOT');
    records.forEach((record, index) => {
      if (output.has(record.chunkId)) fail('CORRUPT_SNAPSHOT');
      output.set(record.chunkId, {
        record: parseProjectionRecordV1({ schemaVersion: '1', ...record }),
        vector: vectors[index] as Float32Array,
      });
    });
  }
  return output;
}

export function createBoundedSnapshotValidator(input: {
  readonly artifacts: SnapshotObjectReader;
  readonly memory: MemoryProbe;
}): SnapshotValidator {
  return async (scope, manifest) => {
    const index = new BoundedDynamoS3RetrievalIndex({
      objects: input.artifacts,
      memory: input.memory,
      authority: {
        getSnapshotHead: () => Promise.resolve(manifest),
        getAuthorizationEpoch: () => Promise.resolve(scope.authorizationEpoch),
        queryDeltas: () => Promise.resolve({ manifests: [] }),
        getExactChunkIds: () => Promise.resolve([]),
        hydrateAuthorization: () => Promise.resolve([]),
        getQueryVector: () => Promise.reject(new Error('not required')),
      },
    });
    await index.applySnapshot(manifest);
  };
}

export class DurableRetrievalCompactor {
  readonly #options: DurableRetrievalCompactorOptions;
  readonly #validate: SnapshotValidator;

  public constructor(options: DurableRetrievalCompactorOptions) {
    this.#options = options;
    this.#validate =
      options.validateSnapshot ??
      createBoundedSnapshotValidator({
        artifacts: options.artifacts,
        memory: options.memory,
      });
    if (
      options.vectorDimension < 1 ||
      !Number.isSafeInteger(options.vectorDimension) ||
      !sha256Schema.safeParse(options.embeddingProfileManifestHash).success
    )
      fail('INDEX_REFRESH_REQUIRED');
  }

  public async compactAndPromote(input: {
    readonly scope: RetrievalScope;
    readonly staged: readonly StagedRetrievalMutationV1[];
    readonly expectedHeadManifestHash?: string;
  }): Promise<CompactionResult> {
    const scope = retrievalScopeSchema.parse(input.scope);
    if (input.staged.length > chiefRetrievalV1.maximumStagedMutations)
      throw new BoundedRetrievalError('RESOURCE_LIMIT');
    assertMemory(this.#options.memory);
    const observedHead = await this.#options.heads.getHead(scope);
    if (
      observedHead !== undefined &&
      (!sameRetrievalDomain(observedHead.scope, scope) ||
        observedHead.scope.authorizationEpoch > scope.authorizationEpoch)
    )
      throw new BoundedRetrievalError('ACCESS_DENIED');
    const observedHash = observedHead?.manifest.manifestHash;
    if (observedHash !== input.expectedHeadManifestHash)
      fail('INDEX_REFRESH_REQUIRED');

    const unique = new Map<string, StagedRetrievalMutationV1>();
    let stagedBytes = 0;
    let duplicates = 0;
    for (const candidate of input.staged) {
      const manifest = validateStagedRetrievalMutation(candidate);
      if (!sameScope(manifest.scope, scope))
        throw new BoundedRetrievalError('ACCESS_DENIED');
      const prior = unique.get(manifest.mutationId);
      if (prior !== undefined) {
        if (canonicalJson(prior) !== canonicalJson(manifest))
          fail('INDEX_REFRESH_REQUIRED');
        duplicates += 1;
        continue;
      }
      unique.set(manifest.mutationId, manifest);
      stagedBytes += manifest.byteLength;
      if (stagedBytes > chiefRetrievalV1.maximumStagedBytes)
        throw new BoundedRetrievalError('RESOURCE_LIMIT');
    }

    const records = await readBaseRecords({
      scope,
      head:
        observedHead !== undefined && sameScope(observedHead.scope, scope)
          ? observedHead
          : undefined,
      artifacts: this.#options.artifacts,
      dimension: this.#options.vectorDimension,
    });
    const ordered = [...unique.values()].sort(
      (left, right) =>
        left.stagingOrdinal.localeCompare(right.stagingOrdinal) ||
        left.mutationId.localeCompare(right.mutationId),
    );
    let appliedMutationCount = 0;
    for (const manifest of ordered) {
      const bytes = await this.#options.artifacts.getImmutableObject(
        manifest.object,
      );
      assertObject(manifest.object, bytes, scope);
      const document = parseStagedMutationObject(
        bytes,
        manifest.stagingOrdinal,
        this.#options.vectorDimension,
      );
      const vectorBytes = canonicalBase64(document.vectorBinary32LeBase64);
      const next = {
        record: document.record,
        vector: decodeBinary32Vectors(
          vectorBytes,
          1,
          this.#options.vectorDimension,
        )[0] as Float32Array,
      };
      const previous = records.get(document.record.chunkId);
      if (
        previous !== undefined &&
        previous.record.mutationOrdinal > document.record.mutationOrdinal
      )
        continue;
      if (
        previous !== undefined &&
        previous.record.mutationOrdinal === document.record.mutationOrdinal
      ) {
        if (
          canonicalJson(previous.record) !== canonicalJson(next.record) ||
          !vectorsEqual(previous.vector, next.vector)
        )
          fail('INDEX_REFRESH_REQUIRED');
        continue;
      }
      records.set(document.record.chunkId, next);
      appliedMutationCount += 1;
      if (records.size > chiefRetrievalV1.maximumSnapshotChunks)
        throw new BoundedRetrievalError('RESOURCE_LIMIT');
      assertMemory(this.#options.memory);
    }

    if (appliedMutationCount === 0 && observedHead !== undefined)
      return Object.freeze({
        status: 'unchanged',
        replayedMutationCount: unique.size,
        appliedMutationCount: 0,
        duplicateMutationCount: duplicates,
        head: observedHead,
      });

    const sorted = [...records.values()].sort((left, right) =>
      compareUtf8(left.record.chunkId, right.record.chunkId),
    );
    const projectionBytes = serializeProjection(
      sorted.map(({ record }) => record),
    );
    const vectorBytes = serializeVectors(sorted.map(({ vector }) => vector));
    const serializedBytes = projectionBytes.byteLength + vectorBytes.byteLength;
    if (
      serializedBytes > chiefRetrievalV1.maximumSnapshotBytes ||
      serializedBytes > chiefRetrievalV1.maximumDecodedBytes
    )
      throw new BoundedRetrievalError('RESOURCE_LIMIT');
    const [chunkIdObject, vectorObject] = await Promise.all([
      this.#options.artifacts.putImmutableObject({
        tenantId: scope.tenantId,
        scopeHash: scope.scopeHash,
        namespace: 'retrieval-snapshots',
        bytes: projectionBytes,
        mediaType: 'application/x-ndjson',
      }),
      this.#options.artifacts.putImmutableObject({
        tenantId: scope.tenantId,
        scopeHash: scope.scopeHash,
        namespace: 'retrieval-snapshots',
        bytes: vectorBytes,
        mediaType: 'application/octet-stream',
      }),
    ]);
    const now = (this.#options.now?.() ?? new Date()).toISOString();
    const generation = (observedHead?.generation ?? 0) + 1;
    const base = retrievalSnapshotManifestSchema.parse({
      schemaVersion: '1',
      tenantId: scope.tenantId,
      role: scope.role,
      scopeHash: scope.scopeHash,
      generation,
      authorizationEpoch: scope.authorizationEpoch,
      sourceWatermark:
        ordered.at(-1)?.stagingOrdinal ??
        observedHead?.manifest.sourceWatermark ??
        `empty:${generation}`,
      embeddingProfileManifestHash: this.#options.embeddingProfileManifestHash,
      vectorDimension: this.#options.vectorDimension,
      normalizationVersion: this.#options.normalizationVersion ?? '1',
      lexicalScoringVersion: 'chief-bounded-fusion-v1',
      vectorFormat: chiefRetrievalV1.vectorFormat,
      shards: [
        {
          chunkIdObject,
          vectorObject,
          chunkCount: sorted.length,
          decodedBytes: serializedBytes,
        },
      ],
      sourceCount: new Set(sorted.map(({ record }) => record.sourceId)).size,
      chunkCount: sorted.length,
      serializedBytes,
      decodedBytes: serializedBytes,
      manifestHash: '0'.repeat(64),
      createdAt: now,
    });
    const manifest = retrievalSnapshotManifestSchema.parse({
      ...base,
      manifestHash: hashManifest(base),
    });
    await this.#validate(scope, manifest);
    const head: DurableRetrievalHeadV1 = Object.freeze({
      contractVersion: chiefRetrievalV1.contractVersion,
      kind: 'snapshot-head',
      scope,
      generation,
      publishedSequenceStart:
        (observedHead?.publishedSequenceEnd ?? 0) +
        (appliedMutationCount === 0 ? 0 : 1),
      publishedSequenceEnd:
        (observedHead?.publishedSequenceEnd ?? 0) + appliedMutationCount,
      manifest,
      promotedAt: now,
    });
    const promoted = await this.#options.heads.compareAndSwapHead({
      scope,
      ...(observedHash === undefined
        ? {}
        : { expectedManifestHash: observedHash }),
      next: head,
    });
    if (promoted === 'stale') fail('INDEX_REFRESH_REQUIRED');
    return Object.freeze({
      status: 'promoted',
      replayedMutationCount: unique.size,
      appliedMutationCount,
      duplicateMutationCount: duplicates,
      head,
    });
  }
}

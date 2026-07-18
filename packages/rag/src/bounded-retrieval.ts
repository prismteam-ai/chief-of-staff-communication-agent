import { createHash } from 'node:crypto';

import {
  chunkIdSchema,
  sha256Schema,
  sourceIdSchema,
} from '@chief/contracts/ids';
import {
  retrievalDeltaManifestSchema,
  retrievalQuerySchema,
  retrievalScopeSchema,
  retrievalSnapshotManifestSchema,
  type Citation,
  type RetrievalCandidate,
  type RetrievalDeltaManifest,
  type RetrievalQuery,
  type RetrievalScope,
  type RetrievalSnapshotManifest,
} from '@chief/contracts/knowledge';
import type { ImmutableBlobRef } from '@chief/contracts/storage';

import type {
  RetrievalDeltaApplyResult,
  RetrievalHealthResult,
  RetrievalIndex,
  RetrievalSnapshotApplyResult,
} from './index.js';

const HARD_SERIALIZED_BYTES = 64 * 1024 * 1024;
const HARD_DECODED_BYTES = 128 * 1024 * 1024;
const HARD_CHUNKS = 10_000;
const HARD_SHARDS = 4;
const HARD_DELTA_CHANGES = 256;
const HARD_DELTA_BYTES = 4 * 1024 * 1024;
const HARD_DELTA_AGE_MS = 120_000;
const HARD_DELTA_PAGES = 4;
const RSS_FRACTION_LIMIT = 0.6;
const HARD_QUERY_VECTOR_BYTES = 256 * 1024;

export type BoundedRetrievalErrorCode =
  | 'ACCESS_DENIED'
  | 'AUTHORIZATION_CHANGED'
  | 'INDEX_REFRESH_REQUIRED'
  | 'INVALID_QUERY_PROFILE'
  | 'CORRUPT_SNAPSHOT'
  | 'RESOURCE_LIMIT';

/** Deliberately contains no tenant, count, score, object key, or candidate ID. */
export class BoundedRetrievalError extends Error {
  public constructor(public readonly code: BoundedRetrievalErrorCode) {
    super(code);
    this.name = 'BoundedRetrievalError';
  }
}

export interface SnapshotObjectReader {
  /** Implementations must issue an S3 GetObject-equivalent read only. */
  getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array>;
}

export interface DeltaPage {
  readonly manifests: readonly RetrievalDeltaManifest[];
  readonly nextToken?: string;
}

export interface AuthorizationHydration {
  readonly chunkId: string;
  readonly state: 'active' | 'denied' | 'tombstoned';
  readonly sourceVersion?: string;
  readonly citationLabel?: string;
  readonly contentHash?: string;
}

export interface RetrievalAuthorityReader {
  /** DynamoDB GetItem on the exact server-derived scope head. */
  getSnapshotHead(
    scope: RetrievalScope,
  ): Promise<RetrievalSnapshotManifest | undefined>;
  /** DynamoDB GetItem on the scope authorization-epoch record. */
  getAuthorizationEpoch(scope: RetrievalScope): Promise<number>;
  /** DynamoDB Query only; Scan is not part of this port. */
  queryDeltas(input: {
    readonly scope: RetrievalScope;
    readonly baseGeneration: number;
    readonly afterSequence: number;
    readonly pageToken?: string;
  }): Promise<DeltaPage>;
  /** Exact operational key/index lookup for current thread/person/Asana refs. */
  getExactChunkIds(input: {
    readonly scope: RetrievalScope;
    readonly expectedAuthorizationEpoch: number;
    readonly exactEntityRefs: readonly string[];
  }): Promise<readonly string[]>;
  /** Current grants, synchronous denies, tombstones, and citation hydration. */
  hydrateAuthorization(input: {
    readonly scope: RetrievalScope;
    readonly expectedAuthorizationEpoch: number;
    readonly chunkIds: readonly string[];
  }): Promise<readonly AuthorizationHydration[]>;
  /** Credentialless persisted query vectors; this wave never calls a model. */
  getQueryVector(input: {
    readonly scope: RetrievalScope;
    readonly queryHash: string;
    readonly embeddingProfileManifestHash: string;
    readonly dimension: number;
  }): Promise<Float32Array>;
}

export interface MemoryProbe {
  sample(): Readonly<{ rssBytes: number; limitBytes: number }>;
}

export interface Clock {
  now(): Date;
}

export interface BoundedRetrievalOptions {
  readonly authority: RetrievalAuthorityReader;
  readonly objects: SnapshotObjectReader;
  readonly memory: MemoryProbe;
  readonly clock?: Clock;
  readonly scoring?: ScoringProfile;
}

export interface ScoringProfile {
  readonly version: 'chief-bounded-fusion-v1';
  readonly bm25K1: number;
  readonly bm25B: number;
  readonly lexicalWeight: number;
  readonly vectorWeight: number;
  readonly exactWeight: number;
  readonly abstentionThreshold: number;
}

export const frozenScoringProfile: ScoringProfile = Object.freeze({
  version: 'chief-bounded-fusion-v1',
  bm25K1: 1.2,
  bm25B: 0.75,
  lexicalWeight: 0.45,
  vectorWeight: 0.4,
  exactWeight: 0.15,
  abstentionThreshold: 0.25,
});

export interface ProjectionRecord {
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
}

interface IndexedRecord extends ProjectionRecord {
  readonly vector: Float32Array;
}

interface DeltaDocument {
  readonly schemaVersion: '1';
  readonly sequence: number;
  readonly operation: 'upsert' | 'delete' | 'tombstone';
  readonly record?: ProjectionRecord;
  readonly vectorBinary32LeBase64?: string;
}

interface LoadedProjection {
  readonly records: ReadonlyMap<string, IndexedRecord>;
  readonly serializedBytes: number;
  readonly decodedBytes: number;
  readonly lastSequence: number;
  readonly deltaCount: number;
}

export interface AuthorizedRetrievalResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly citations: readonly Citation[];
  readonly abstained: boolean;
  readonly authorizationEpoch: number;
  readonly snapshotManifestHash: string;
  readonly scoringProfileVersion: ScoringProfile['version'];
  readonly evidence: readonly RetrievedEvidence[];
}

export interface RetrievedEvidence {
  readonly chunkId: string;
  readonly citationId: string;
  readonly text: string;
}

export interface InProcessQueryVector {
  readonly queryHash: string;
  readonly embeddingProfileManifestHash: string;
  readonly vector: Float32Array;
}

export interface ReadOnlyInspection {
  readonly status: 'ready';
  readonly generation: number;
  readonly authorizationEpoch: number;
  readonly chunkCount: number;
  readonly pendingDeltaCount: 0;
  readonly shardCount: number;
  readonly manifestHash: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code: BoundedRetrievalErrorCode): never {
  throw new BoundedRetrievalError(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([key]) => key !== 'manifestHash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashManifest(
  manifest: RetrievalSnapshotManifest | RetrievalDeltaManifest,
): string {
  return sha256(encoder.encode(canonicalize(manifest)));
}

function sameScope(
  manifest: RetrievalSnapshotManifest | RetrievalDeltaManifest,
  scope: RetrievalScope,
): boolean {
  return (
    manifest.tenantId === scope.tenantId &&
    manifest.scopeHash === scope.scopeHash &&
    manifest.role === scope.role &&
    manifest.authorizationEpoch === scope.authorizationEpoch
  );
}

function assertObject(
  ref: ImmutableBlobRef,
  bytes: Uint8Array,
  tenantId: string,
  scopeHash: string,
): void {
  if (
    ref.tenantId !== tenantId ||
    ref.byteLength !== bytes.byteLength ||
    ref.contentHash !== sha256(bytes) ||
    ref.objectKey.includes('..') ||
    !ref.objectKey.includes(ref.contentHash) ||
    !ref.objectKey.includes(scopeHash)
  )
    fail('CORRUPT_SNAPSHOT');
}

function assertManifest(manifest: RetrievalSnapshotManifest): void {
  const shardChunks = manifest.shards.reduce(
    (sum, shard) => sum + shard.chunkCount,
    0,
  );
  if (
    manifest.schemaVersion !== '1' ||
    manifest.vectorFormat !== 'binary32-le-row-major' ||
    manifest.shards.length > HARD_SHARDS ||
    manifest.chunkCount > HARD_CHUNKS ||
    shardChunks !== manifest.chunkCount ||
    manifest.serializedBytes > HARD_SERIALIZED_BYTES ||
    manifest.decodedBytes > HARD_DECODED_BYTES ||
    hashManifest(manifest) !== manifest.manifestHash
  )
    fail('CORRUPT_SNAPSHOT');
}

function parseProjectionLine(line: string): ProjectionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    fail('CORRUPT_SNAPSHOT');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    fail('CORRUPT_SNAPSHOT');
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = [
    'chunkId',
    'exactEntityRefs',
    'schemaVersion',
    'sourceId',
    'sourceVersion',
    'text',
    'tokenCount',
    'citationLabel',
    'contentHash',
    'state',
    'mutationOrdinal',
  ].sort();
  if (
    keys.join('\u0000') !== expected.join('\u0000') ||
    value.schemaVersion !== '1' ||
    !chunkIdSchema.safeParse(value.chunkId).success ||
    !sourceIdSchema.safeParse(value.sourceId).success ||
    typeof value.sourceVersion !== 'string' ||
    value.sourceVersion.length === 0 ||
    typeof value.text !== 'string' ||
    !Number.isSafeInteger(value.tokenCount) ||
    (value.tokenCount as number) < 0 ||
    !Array.isArray(value.exactEntityRefs) ||
    value.exactEntityRefs.some(
      (entry) => typeof entry !== 'string' || entry.length === 0,
    ) ||
    typeof value.citationLabel !== 'string' ||
    value.citationLabel.length === 0 ||
    !sha256Schema.safeParse(value.contentHash).success ||
    value.contentHash !== sha256(encoder.encode(value.text)) ||
    !['active', 'tombstoned'].includes(value.state as string) ||
    typeof value.mutationOrdinal !== 'string' ||
    value.mutationOrdinal.length === 0
  )
    fail('CORRUPT_SNAPSHOT');
  return Object.freeze({
    chunkId: value.chunkId as string,
    sourceId: value.sourceId as string,
    sourceVersion: value.sourceVersion,
    text: value.text,
    tokenCount: value.tokenCount as number,
    exactEntityRefs: Object.freeze([...(value.exactEntityRefs as string[])]),
    citationLabel: value.citationLabel,
    contentHash: value.contentHash,
    state: value.state as 'active' | 'tombstoned',
    mutationOrdinal: value.mutationOrdinal,
  });
}

export function readProjectionRecords(
  bytes: Uint8Array,
): readonly ProjectionRecord[] {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail('CORRUPT_SNAPSHOT');
  }
  if (text.length === 0) return [];
  if (!text.endsWith('\n')) fail('CORRUPT_SNAPSHOT');
  return Object.freeze(text.slice(0, -1).split('\n').map(parseProjectionLine));
}

export function decodeBinary32Vectors(
  bytes: Uint8Array,
  count: number,
  dimension: number,
): readonly Float32Array[] {
  const expected = count * dimension * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expected) || bytes.byteLength !== expected)
    fail('CORRUPT_SNAPSHOT');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: Float32Array[] = [];
  for (let row = 0; row < count; row += 1) {
    const vector = new Float32Array(dimension);
    let magnitude = 0;
    for (let column = 0; column < dimension; column += 1) {
      const value = view.getFloat32((row * dimension + column) * 4, true);
      if (!Number.isFinite(value)) fail('CORRUPT_SNAPSHOT');
      vector[column] = value;
      magnitude += value * value;
    }
    if (magnitude === 0) fail('CORRUPT_SNAPSHOT');
    rows.push(vector);
  }
  return Object.freeze(rows);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function decodeCanonicalBase64(value: string): Uint8Array {
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

function parseDelta(bytes: Uint8Array): readonly DeltaDocument[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    fail('INDEX_REFRESH_REQUIRED');
  }
  if (!Array.isArray(parsed)) fail('INDEX_REFRESH_REQUIRED');
  return parsed.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      fail('INDEX_REFRESH_REQUIRED');
    const value = item as Record<string, unknown>;
    if (
      value.schemaVersion !== '1' ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 0 ||
      !['upsert', 'delete', 'tombstone'].includes(value.operation as string)
    )
      fail('INDEX_REFRESH_REQUIRED');
    const operation = value.operation as DeltaDocument['operation'];
    if (operation === 'upsert') {
      if (
        !hasExactKeys(value, [
          'schemaVersion',
          'sequence',
          'operation',
          'record',
          'vectorBinary32LeBase64',
        ]) ||
        value.record === undefined ||
        typeof value.vectorBinary32LeBase64 !== 'string'
      )
        fail('INDEX_REFRESH_REQUIRED');
      decodeCanonicalBase64(value.vectorBinary32LeBase64);
      return Object.freeze({
        schemaVersion: '1' as const,
        sequence: value.sequence as number,
        operation,
        record: parseProjectionLine(JSON.stringify(value.record)),
        vectorBinary32LeBase64: value.vectorBinary32LeBase64,
      });
    }
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'sequence',
        'operation',
        'chunkId',
      ]) ||
      !chunkIdSchema.safeParse(value.chunkId).success
    )
      fail('INDEX_REFRESH_REQUIRED');
    return Object.freeze({
      schemaVersion: '1' as const,
      sequence: value.sequence as number,
      operation,
      record: Object.freeze({
        chunkId: value.chunkId as string,
        sourceId: value.chunkId as string,
        sourceVersion: 'deleted',
        text: '',
        tokenCount: 0,
        exactEntityRefs: Object.freeze([]),
        citationLabel: 'Deleted evidence',
        contentHash: sha256(encoder.encode('')),
        state: 'tombstoned',
        mutationOrdinal: `delta:${String(value.sequence)}`,
      }),
    });
  });
}

function assertDeltaContents(
  manifest: RetrievalDeltaManifest,
  changes: readonly DeltaDocument[],
): void {
  if (
    changes.length === 0 ||
    changes.length !== manifest.changeCount ||
    changes[0]?.sequence !== manifest.sequenceStart ||
    changes.at(-1)?.sequence !== manifest.sequenceEnd ||
    changes.some(
      (change, index) => change.sequence !== manifest.sequenceStart + index,
    )
  )
    fail('INDEX_REFRESH_REQUIRED');
}

function decodedDeltaBytes(changes: readonly DeltaDocument[]): number {
  let total = 0;
  for (const change of changes) {
    const record = change.record as ProjectionRecord;
    total += encoder.encode(record.chunkId).byteLength;
    if (change.operation === 'upsert') {
      total += encoder.encode(record.sourceId).byteLength;
      total += encoder.encode(record.sourceVersion).byteLength;
      total += encoder.encode(record.text).byteLength;
      total += decodeCanonicalBase64(
        change.vectorBinary32LeBase64 as string,
      ).byteLength;
    }
  }
  return total;
}

export function tokenize(text: string): readonly string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  return Object.freeze(
    normalized.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [],
  );
}

export function bm25Scores(
  queryTokens: readonly string[],
  documents: readonly (readonly string[])[],
  k1 = frozenScoringProfile.bm25K1,
  b = frozenScoringProfile.bm25B,
): readonly number[] {
  if (documents.length === 0) return Object.freeze([]);
  const terms = [...new Set(queryTokens)];
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) /
      documents.length || 1;
  const frequencies = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(
      term,
      frequencies.reduce(
        (count, frequency) => count + (frequency.has(term) ? 1 : 0),
        0,
      ),
    );
  }
  return Object.freeze(
    documents.map((document, index) => {
      let score = 0;
      for (const term of terms) {
        const tf = frequencies[index]?.get(term) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const denominator =
          tf + k1 * (1 - b + b * (document.length / averageLength));
        score += idf * ((tf * (k1 + 1)) / denominator);
      }
      return score;
    }),
  );
}

export function exhaustiveCosine(
  query: Float32Array,
  vectors: readonly Float32Array[],
): readonly number[] {
  return Object.freeze(
    vectors.map((vector) => {
      if (vector.length !== query.length) fail('INVALID_QUERY_PROFILE');
      let dot = Math.fround(0);
      let queryMagnitude = Math.fround(0);
      let vectorMagnitude = Math.fround(0);
      for (let index = 0; index < query.length; index += 1) {
        const left = query[index] as number;
        const right = vector[index] as number;
        dot = Math.fround(dot + Math.fround(left * right));
        queryMagnitude = Math.fround(queryMagnitude + Math.fround(left * left));
        vectorMagnitude = Math.fround(
          vectorMagnitude + Math.fround(right * right),
        );
      }
      if (queryMagnitude === 0 || vectorMagnitude === 0)
        fail('INVALID_QUERY_PROFILE');
      return Math.fround(
        dot / Math.sqrt(Math.fround(queryMagnitude * vectorMagnitude)),
      );
    }),
  );
}

function assertMemory(memory: MemoryProbe): void {
  const sample = memory.sample();
  if (
    !Number.isFinite(sample.rssBytes) ||
    !Number.isFinite(sample.limitBytes) ||
    sample.rssBytes < 0 ||
    sample.limitBytes <= 0 ||
    sample.rssBytes / sample.limitBytes >= RSS_FRACTION_LIMIT
  )
    fail('RESOURCE_LIMIT');
}

export function assertBoundedAggregate(input: {
  readonly snapshotSerializedBytes: number;
  readonly deltaSerializedBytes: number;
  readonly snapshotDecodedBytes: number;
  readonly deltaDecodedBytes: number;
}): void {
  if (
    !Object.values(input).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    input.snapshotSerializedBytes + input.deltaSerializedBytes >
      HARD_SERIALIZED_BYTES ||
    input.snapshotDecodedBytes + input.deltaDecodedBytes > HARD_DECODED_BYTES
  )
    fail('INDEX_REFRESH_REQUIRED');
}

export class BoundedDynamoS3RetrievalIndex implements RetrievalIndex {
  readonly #authority: RetrievalAuthorityReader;
  readonly #objects: SnapshotObjectReader;
  readonly #memory: MemoryProbe;
  readonly #clock: Clock;
  readonly #scoring: ScoringProfile;

  public constructor(options: BoundedRetrievalOptions) {
    this.#authority = options.authority;
    this.#objects = options.objects;
    this.#memory = options.memory;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#scoring = options.scoring ?? frozenScoringProfile;
    if (
      this.#scoring.version !== frozenScoringProfile.version ||
      this.#scoring.lexicalWeight +
        this.#scoring.vectorWeight +
        this.#scoring.exactWeight !==
        1
    )
      fail('INVALID_QUERY_PROFILE');
  }

  public async applySnapshot(
    manifest: RetrievalSnapshotManifest,
  ): Promise<RetrievalSnapshotApplyResult> {
    const parsed = retrievalSnapshotManifestSchema.safeParse(manifest);
    if (!parsed.success) fail('CORRUPT_SNAPSHOT');
    const safeManifest = parsed.data;
    const scope = this.#scopeFromManifest(safeManifest);
    await this.#assertEpoch(scope, safeManifest.authorizationEpoch);
    await this.#loadSnapshot(safeManifest);
    await this.#assertEpoch(scope, safeManifest.authorizationEpoch);
    return Object.freeze({
      kind: 'snapshot',
      tenantId: safeManifest.tenantId,
      scopeHash: safeManifest.scopeHash,
      role: safeManifest.role,
      generation: safeManifest.generation,
      authorizationEpoch: safeManifest.authorizationEpoch,
      manifestHash: safeManifest.manifestHash,
      appliedAt: this.#clock.now().toISOString(),
    });
  }

  public async applyDelta(
    manifest: RetrievalDeltaManifest,
  ): Promise<RetrievalDeltaApplyResult> {
    const parsed = retrievalDeltaManifestSchema.safeParse(manifest);
    if (!parsed.success) fail('INDEX_REFRESH_REQUIRED');
    const safeManifest = parsed.data;
    const scope = this.#scopeFromManifest(safeManifest);
    await this.#assertEpoch(scope, safeManifest.authorizationEpoch);
    const changes = await this.#readDelta(safeManifest);
    assertDeltaContents(safeManifest, changes);
    await this.#assertEpoch(scope, safeManifest.authorizationEpoch);
    return Object.freeze({
      kind: 'delta',
      tenantId: safeManifest.tenantId,
      scopeHash: safeManifest.scopeHash,
      role: safeManifest.role,
      baseGeneration: safeManifest.baseGeneration,
      authorizationEpoch: safeManifest.authorizationEpoch,
      sequenceEnd: safeManifest.sequenceEnd,
      manifestHash: safeManifest.manifestHash,
      appliedAt: this.#clock.now().toISOString(),
    });
  }

  public async query(
    input: RetrievalQuery,
  ): Promise<readonly RetrievalCandidate[]> {
    return (await this.queryWithCitations(input)).candidates;
  }

  public async queryWithCitations(
    input: RetrievalQuery,
    inProcessQueryVector?: InProcessQueryVector,
  ): Promise<AuthorizedRetrievalResult> {
    const parsed = retrievalQuerySchema.safeParse(input);
    if (!parsed.success) fail('INVALID_QUERY_PROFILE');
    const safeInput = parsed.data;
    let currentInput = safeInput;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#queryAtStableEpoch(
          currentInput,
          inProcessQueryVector,
        );
      } catch (error) {
        if (
          error instanceof BoundedRetrievalError &&
          error.code === 'AUTHORIZATION_CHANGED' &&
          attempt === 0
        ) {
          const authorizationEpoch =
            await this.#authority.getAuthorizationEpoch(safeInput.scope);
          currentInput = {
            ...safeInput,
            scope: { ...safeInput.scope, authorizationEpoch },
          };
          continue;
        }
        if (
          error instanceof BoundedRetrievalError &&
          error.code === 'AUTHORIZATION_CHANGED'
        )
          fail('ACCESS_DENIED');
        throw error;
      }
    }
    fail('ACCESS_DENIED');
  }

  public async inspect(scope: RetrievalScope): Promise<ReadOnlyInspection> {
    const parsed = retrievalScopeSchema.safeParse(scope);
    if (!parsed.success) fail('ACCESS_DENIED');
    const safeScope = parsed.data;
    const projection = await this.#loadAtStableEpoch(safeScope);
    const chunkCount = await this.#countCurrentlyAuthorized(
      safeScope,
      projection.manifest.authorizationEpoch,
      projection.loaded.records,
    );
    return Object.freeze({
      status: 'ready',
      generation: projection.manifest.generation,
      authorizationEpoch: projection.manifest.authorizationEpoch,
      chunkCount,
      pendingDeltaCount: 0,
      shardCount: projection.manifest.shards.length,
      manifestHash: projection.manifest.manifestHash,
    });
  }

  public async health(scope: RetrievalScope): Promise<RetrievalHealthResult> {
    const observedAt = this.#clock.now().toISOString();
    try {
      const parsed = retrievalScopeSchema.safeParse(scope);
      if (!parsed.success) fail('ACCESS_DENIED');
      const safeScope = parsed.data;
      const projection = await this.#loadAtStableEpoch(safeScope);
      const indexedChunkCount = await this.#countCurrentlyAuthorized(
        safeScope,
        projection.manifest.authorizationEpoch,
        projection.loaded.records,
      );
      return Object.freeze({
        status: 'healthy',
        scope: safeScope,
        activeGeneration: projection.manifest.generation,
        authorizationEpoch: projection.manifest.authorizationEpoch,
        indexedChunkCount,
        pendingDeltaCount: 0,
        observedAt,
      });
    } catch (error) {
      const reasonCode =
        error instanceof BoundedRetrievalError
          ? error.code
          : 'INDEX_REFRESH_REQUIRED';
      return Object.freeze({
        status: 'unavailable',
        scope,
        indexedChunkCount: 0,
        pendingDeltaCount: 0,
        observedAt,
        reasonCode,
      });
    }
  }

  async #queryAtStableEpoch(
    input: RetrievalQuery,
    inProcessQueryVector?: InProcessQueryVector,
  ): Promise<AuthorizedRetrievalResult> {
    const projection = await this.#loadAtStableEpoch(input.scope);
    const { manifest, loaded } = projection;
    if (
      input.embeddingProfileManifestHash !==
      manifest.embeddingProfileManifestHash
    )
      fail('INVALID_QUERY_PROFILE');

    const ids = [...loaded.records.keys()].sort(compareUtf8);
    const requested = new Set(ids);
    const active = new Map(
      ids.flatMap((id) => {
        const record = loaded.records.get(id) as IndexedRecord;
        return record.state === 'active' ? [[id, record] as const] : [];
      }),
    );
    const records = ids
      .filter((id) => active.has(id))
      .map((id) => loaded.records.get(id) as IndexedRecord);
    if (records.length === 0)
      return this.#abstention(
        manifest.authorizationEpoch,
        manifest.manifestHash,
      );

    if (
      inProcessQueryVector !== undefined &&
      (inProcessQueryVector.queryHash !== input.queryHash ||
        inProcessQueryVector.embeddingProfileManifestHash !==
          input.embeddingProfileManifestHash ||
        !(inProcessQueryVector.vector instanceof Float32Array) ||
        inProcessQueryVector.vector.byteLength > HARD_QUERY_VECTOR_BYTES ||
        inProcessQueryVector.vector.some((value) => !Number.isFinite(value)))
    )
      fail('INVALID_QUERY_PROFILE');
    const queryVector =
      inProcessQueryVector?.vector ??
      (await this.#authority.getQueryVector({
        scope: input.scope,
        queryHash: input.queryHash,
        embeddingProfileManifestHash: input.embeddingProfileManifestHash,
        dimension: manifest.vectorDimension,
      }));
    if (
      queryVector.length !== manifest.vectorDimension ||
      queryVector.byteLength > HARD_QUERY_VECTOR_BYTES
    )
      fail('INVALID_QUERY_PROFILE');
    assertMemory(this.#memory);

    const lexical = bm25Scores(
      tokenize(input.queryText),
      records.map((record) => tokenize(record.text)),
      this.#scoring.bm25K1,
      this.#scoring.bm25B,
    );
    const vector = exhaustiveCosine(
      queryVector,
      records.map((record) => record.vector),
    );
    const maxLexical = Math.max(0, ...lexical);
    const exactRefs = new Set(input.exactEntityRefs);
    const exactChunkIds = new Set(
      records
        .filter((record) =>
          record.exactEntityRefs.some((reference) => exactRefs.has(reference)),
        )
        .map((record) => record.chunkId),
    );
    if ([...exactChunkIds].some((chunkId) => !requested.has(chunkId)))
      fail('ACCESS_DENIED');
    await this.#assertEpoch(input.scope, manifest.authorizationEpoch);
    const scored = records.map((record, index) => {
      const lexicalScore = lexical[index] as number;
      const vectorScore = vector[index] as number;
      const exactScore = exactChunkIds.has(record.chunkId) ? 1 : 0;
      const lexicalNormalized =
        maxLexical === 0 ? 0 : lexicalScore / maxLexical;
      const vectorNormalized = Math.max(0, Math.min(1, (vectorScore + 1) / 2));
      const fusedScore =
        this.#scoring.lexicalWeight * lexicalNormalized +
        this.#scoring.vectorWeight * vectorNormalized +
        this.#scoring.exactWeight * exactScore;
      return { record, lexicalScore, vectorScore, fusedScore };
    });
    scored.sort(
      (left, right) =>
        right.fusedScore - left.fusedScore ||
        compareUtf8(left.record.chunkId, right.record.chunkId),
    );
    if (
      scored.length === 0 ||
      (scored[0]?.fusedScore ?? 0) < this.#scoring.abstentionThreshold
    )
      return this.#abstention(
        manifest.authorizationEpoch,
        manifest.manifestHash,
      );

    const selected = scored
      .filter(
        ({ fusedScore }) => fusedScore >= this.#scoring.abstentionThreshold,
      )
      .slice(0, input.limit);
    const candidates = selected.map(({ record, ...scores }) =>
      Object.freeze({
        chunkId: chunkIdSchema.parse(record.chunkId),
        sourceId: sourceIdSchema.parse(record.sourceId),
        lexicalScore: scores.lexicalScore,
        vectorScore: scores.vectorScore,
        fusedScore: scores.fusedScore,
        authorizationEpoch: manifest.authorizationEpoch,
      }),
    );
    const citations = selected.map(({ record }) => {
      const grant = active.get(record.chunkId) as IndexedRecord;
      return Object.freeze({
        citationId: `${record.sourceId}:${record.chunkId}:${grant.sourceVersion}`,
        sourceId: sourceIdSchema.parse(record.sourceId),
        sourceVersion: grant.sourceVersion,
        chunkId: chunkIdSchema.parse(record.chunkId),
        label: grant.citationLabel,
        contentHash: sha256Schema.parse(grant.contentHash),
        hydratedUnderAuthorizationEpoch: manifest.authorizationEpoch,
      });
    });
    const evidence = selected.map(({ record }, index) =>
      Object.freeze({
        chunkId: record.chunkId,
        citationId: (citations[index] as Citation).citationId,
        text: record.text,
      }),
    );
    await this.#assertEpoch(input.scope, manifest.authorizationEpoch);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      citations: Object.freeze(citations),
      abstained: false,
      authorizationEpoch: manifest.authorizationEpoch,
      snapshotManifestHash: manifest.manifestHash,
      scoringProfileVersion: this.#scoring.version,
      evidence: Object.freeze(evidence),
    });
  }

  #abstention(epoch: number, manifestHash: string): AuthorizedRetrievalResult {
    return Object.freeze({
      candidates: Object.freeze([]),
      citations: Object.freeze([]),
      abstained: true,
      authorizationEpoch: epoch,
      snapshotManifestHash: manifestHash,
      scoringProfileVersion: this.#scoring.version,
      evidence: Object.freeze([]),
    });
  }

  async #countCurrentlyAuthorized(
    scope: RetrievalScope,
    expectedAuthorizationEpoch: number,
    records: ReadonlyMap<string, IndexedRecord>,
  ): Promise<number> {
    const active = [...records.values()].filter(
      (record) => record.state === 'active',
    ).length;
    await this.#assertEpoch(scope, expectedAuthorizationEpoch);
    return active;
  }

  async #loadAtStableEpoch(scope: RetrievalScope): Promise<{
    readonly manifest: RetrievalSnapshotManifest;
    readonly loaded: LoadedProjection;
  }> {
    await this.#assertEpoch(scope, scope.authorizationEpoch);
    let rawManifest: RetrievalSnapshotManifest | undefined;
    try {
      rawManifest = await this.#authority.getSnapshotHead(scope);
    } catch {
      fail('INDEX_REFRESH_REQUIRED');
    }
    const parsed = retrievalSnapshotManifestSchema.safeParse(rawManifest);
    if (!rawManifest) fail('ACCESS_DENIED');
    if (!parsed.success) fail('CORRUPT_SNAPSHOT');
    if (!sameScope(parsed.data, scope)) fail('ACCESS_DENIED');
    const manifest = parsed.data;
    const snapshot = await this.#loadSnapshot(manifest);
    const loaded = await this.#overlayDeltas(scope, manifest, snapshot);
    await this.#assertEpoch(scope, manifest.authorizationEpoch);
    return { manifest, loaded };
  }

  async #loadSnapshot(
    manifest: RetrievalSnapshotManifest,
  ): Promise<LoadedProjection> {
    assertManifest(manifest);
    if (manifest.lexicalScoringVersion !== this.#scoring.version)
      fail('INVALID_QUERY_PROFILE');
    const records = new Map<string, IndexedRecord>();
    let serializedBytes = 0;
    let decodedBytes = 0;
    for (const shard of manifest.shards) {
      const [projectionBytes, vectorBytes] = await Promise.all([
        this.#readImmutableObject(shard.chunkIdObject, 'CORRUPT_SNAPSHOT'),
        this.#readImmutableObject(shard.vectorObject, 'CORRUPT_SNAPSHOT'),
      ]);
      assertObject(
        shard.chunkIdObject,
        projectionBytes,
        manifest.tenantId,
        manifest.scopeHash,
      );
      assertObject(
        shard.vectorObject,
        vectorBytes,
        manifest.tenantId,
        manifest.scopeHash,
      );
      const projection = readProjectionRecords(projectionBytes);
      const vectors = decodeBinary32Vectors(
        vectorBytes,
        shard.chunkCount,
        manifest.vectorDimension,
      );
      if (projection.length !== shard.chunkCount) fail('CORRUPT_SNAPSHOT');
      let previous: string | undefined;
      for (let index = 0; index < projection.length; index += 1) {
        const record = projection[index] as ProjectionRecord;
        if (
          (previous !== undefined &&
            compareUtf8(previous, record.chunkId) >= 0) ||
          records.has(record.chunkId) ||
          tokenize(record.text).length !== record.tokenCount
        )
          fail('CORRUPT_SNAPSHOT');
        previous = record.chunkId;
        records.set(
          record.chunkId,
          Object.freeze({ ...record, vector: vectors[index] as Float32Array }),
        );
      }
      serializedBytes += projectionBytes.byteLength + vectorBytes.byteLength;
      const shardDecodedBytes =
        projectionBytes.byteLength +
        vectors.reduce((sum, vector) => sum + vector.byteLength, 0);
      decodedBytes += shardDecodedBytes;
      if (shardDecodedBytes > shard.decodedBytes) fail('CORRUPT_SNAPSHOT');
      assertMemory(this.#memory);
    }
    if (
      records.size !== manifest.chunkCount ||
      new Set([...records.values()].map((record) => record.sourceId)).size !==
        manifest.sourceCount ||
      serializedBytes !== manifest.serializedBytes ||
      decodedBytes > manifest.decodedBytes ||
      serializedBytes > HARD_SERIALIZED_BYTES ||
      decodedBytes > HARD_DECODED_BYTES
    )
      fail('CORRUPT_SNAPSHOT');
    return Object.freeze({
      records,
      serializedBytes,
      decodedBytes,
      lastSequence: 0,
      deltaCount: 0,
    });
  }

  async #overlayDeltas(
    scope: RetrievalScope,
    manifest: RetrievalSnapshotManifest,
    snapshot: LoadedProjection,
  ): Promise<LoadedProjection> {
    const records = new Map(snapshot.records);
    let pageToken: string | undefined;
    let lastSequence = 0;
    let totalChanges = 0;
    let totalBytes = 0;
    let totalDecodedBytes = 0;
    let pageCount = 0;
    do {
      let page: DeltaPage;
      try {
        page = await this.#authority.queryDeltas({
          scope,
          baseGeneration: manifest.generation,
          afterSequence: lastSequence,
          pageToken,
        });
      } catch {
        fail('INDEX_REFRESH_REQUIRED');
      }
      if (
        page === null ||
        typeof page !== 'object' ||
        !Array.isArray(page.manifests) ||
        (page.nextToken !== undefined &&
          (typeof page.nextToken !== 'string' || page.nextToken.length === 0))
      )
        fail('INDEX_REFRESH_REQUIRED');
      pageCount += 1;
      if (pageCount > HARD_DELTA_PAGES) fail('INDEX_REFRESH_REQUIRED');
      for (const rawDelta of page.manifests) {
        const parsedDelta = retrievalDeltaManifestSchema.safeParse(rawDelta);
        if (!parsedDelta.success) fail('INDEX_REFRESH_REQUIRED');
        const delta = parsedDelta.data;
        if (
          !sameScope(delta, scope) ||
          delta.baseGeneration !== manifest.generation ||
          delta.sequenceStart !== lastSequence + 1 ||
          delta.changeCount > HARD_DELTA_CHANGES ||
          delta.byteLength > HARD_DELTA_BYTES ||
          hashManifest(delta) !== delta.manifestHash ||
          this.#clock.now().getTime() - Date.parse(delta.createdAt) >
            HARD_DELTA_AGE_MS
        )
          fail('INDEX_REFRESH_REQUIRED');
        const changes = await this.#readDelta(delta);
        assertDeltaContents(delta, changes);
        const deltaDecodedBytes = decodedDeltaBytes(changes);
        for (const change of changes) {
          if (change.sequence !== lastSequence + 1)
            fail('INDEX_REFRESH_REQUIRED');
          lastSequence = change.sequence;
          const record = change.record as ProjectionRecord;
          if (change.operation === 'upsert') {
            if (tokenize(record.text).length !== record.tokenCount)
              fail('INDEX_REFRESH_REQUIRED');
            const binary = decodeCanonicalBase64(
              change.vectorBinary32LeBase64 as string,
            );
            const vector = decodeBinary32Vectors(
              binary,
              1,
              manifest.vectorDimension,
            )[0] as Float32Array;
            records.set(record.chunkId, Object.freeze({ ...record, vector }));
          } else {
            records.delete(record.chunkId);
          }
        }
        totalChanges += changes.length;
        totalBytes += delta.byteLength;
        totalDecodedBytes += deltaDecodedBytes;
        assertBoundedAggregate({
          snapshotSerializedBytes: snapshot.serializedBytes,
          deltaSerializedBytes: totalBytes,
          snapshotDecodedBytes: snapshot.decodedBytes,
          deltaDecodedBytes: totalDecodedBytes,
        });
        if (
          totalChanges > HARD_DELTA_CHANGES ||
          totalBytes > HARD_DELTA_BYTES ||
          records.size > HARD_CHUNKS
        )
          fail('INDEX_REFRESH_REQUIRED');
      }
      pageToken = page.nextToken;
      if (pageToken && pageCount === HARD_DELTA_PAGES)
        fail('INDEX_REFRESH_REQUIRED');
    } while (pageToken);
    assertMemory(this.#memory);
    return Object.freeze({
      records,
      serializedBytes: snapshot.serializedBytes + totalBytes,
      decodedBytes: snapshot.decodedBytes + totalDecodedBytes,
      lastSequence,
      deltaCount: totalChanges,
    });
  }

  async #readDelta(
    manifest: RetrievalDeltaManifest,
  ): Promise<readonly DeltaDocument[]> {
    if (
      manifest.changeCount > HARD_DELTA_CHANGES ||
      manifest.byteLength > HARD_DELTA_BYTES ||
      hashManifest(manifest) !== manifest.manifestHash
    )
      fail('INDEX_REFRESH_REQUIRED');
    const bytes = await this.#readImmutableObject(
      manifest.object,
      'INDEX_REFRESH_REQUIRED',
    );
    assertObject(manifest.object, bytes, manifest.tenantId, manifest.scopeHash);
    if (bytes.byteLength !== manifest.byteLength)
      fail('INDEX_REFRESH_REQUIRED');
    return parseDelta(bytes);
  }

  async #readImmutableObject(
    ref: ImmutableBlobRef,
    errorCode: BoundedRetrievalErrorCode,
  ): Promise<Uint8Array> {
    try {
      const bytes = await this.#objects.getImmutableObject(ref);
      if (!(bytes instanceof Uint8Array)) fail(errorCode);
      return bytes;
    } catch (error) {
      if (error instanceof BoundedRetrievalError) throw error;
      fail(errorCode);
    }
  }

  async #assertEpoch(scope: RetrievalScope, expected: number): Promise<void> {
    const actual = await this.#authority.getAuthorizationEpoch(scope);
    if (actual !== expected) fail('AUTHORIZATION_CHANGED');
  }

  #scopeFromManifest(
    manifest: RetrievalSnapshotManifest | RetrievalDeltaManifest,
  ): RetrievalScope {
    return Object.freeze({
      derivation: 'server_grants',
      tenantId: manifest.tenantId,
      accountIds: [],
      brandIds: [],
      authorizationEpoch: manifest.authorizationEpoch,
      scopeHash: manifest.scopeHash,
      role: manifest.role,
    });
  }
}

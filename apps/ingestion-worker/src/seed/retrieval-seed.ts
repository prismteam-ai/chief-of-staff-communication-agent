import {
  deterministicEvaluatorIdentityV2,
  immutableBlobRefSchema,
  type ImmutableBlobRef,
} from '@chief/contracts';
import {
  retrievalScopeSchema,
  type RetrievalScope,
} from '@chief/contracts/knowledge';
import { KeyCodec } from '@chief/persistence-dynamodb';
import {
  BoundedRetrievalError,
  DeterministicEffectDisabledEmbedding,
  DurableRetrievalCompactor,
  canonicalJson,
  createBoundedSnapshotValidator,
  decodeBinary32Vectors,
  listBoundedStagedRetrieval,
  parseStagedMutationObject,
  parseProjectionSourceAuthority,
  readProjectionRecords,
  sha256Bytes,
  type DurableRetrievalHeadStore,
  type ImmutableRetrievalArtifactStore,
  type MemoryProbe,
  type ProjectionRecord,
  type RetrievalStagingCatalog,
  type RetrievalStagingRegistrar,
  type StagedMutationDocumentV1,
} from '@chief/rag';

import { S3RetrievalMutationSink } from '../aws-composition.js';
import {
  DeterministicRetrievalMutationSink,
  InMemoryIngestionStore,
  RecordingRetrievalIndex,
} from '../memory-store.js';
import { CanonicalIngestionPipeline } from '../pipeline.js';
import type {
  CanonicalWrite,
  IngestionEvent,
  IngestionWorkItem,
} from '../types.js';
import {
  buildHostedEvaluatorCorpusV2,
  HOSTED_CORPUS_SEED_AT,
  hostedEvaluatorBrandCountsV2,
  hostedEvaluatorChannelCountsV2,
} from './hosted-corpus.js';

const SEED_VERSION = 'chief-evaluator-retrieval-seed.v2';
const NON_SECRET_DIGEST_BYTE = 71;

export const evaluatorRetrievalScope = retrievalScopeSchema.parse({
  derivation: 'server_grants',
  tenantId: deterministicEvaluatorIdentityV2.tenantId,
  accountIds: deterministicEvaluatorIdentityV2.accountIds,
  brandIds: deterministicEvaluatorIdentityV2.brandIds,
  authorizationEpoch: deterministicEvaluatorIdentityV2.authorizationEpoch,
  scopeHash: deterministicEvaluatorIdentityV2.scopeHash,
  role: 'factual',
});

export const evaluatorRetrievalSeedId = sha256Bytes(
  canonicalJson({
    seedVersion: SEED_VERSION,
    identity: deterministicEvaluatorIdentityV2,
    scope: evaluatorRetrievalScope,
    corpus: deterministicEvaluatorIdentityV2.corpus,
    channelCounts: hostedEvaluatorChannelCountsV2,
    brandCounts: hostedEvaluatorBrandCountsV2,
  }),
);

type SeedAuthority = RetrievalStagingRegistrar &
  RetrievalStagingCatalog &
  DurableRetrievalHeadStore;

export interface EvaluatorRetrievalSeedDependencies {
  readonly artifacts: ImmutableRetrievalArtifactStore;
  readonly authority: SeedAuthority;
  readonly readAuthorizationEpoch: () => Promise<number | undefined>;
  readonly memory: MemoryProbe;
}

export interface EvaluatorRetrievalSeedResult {
  readonly schemaVersion: '1';
  readonly seedVersion: typeof SEED_VERSION;
  readonly seedId: string;
  readonly status: 'seeded' | 'already_current';
  readonly scopeHash: string;
  readonly authorizationEpoch: 1;
  readonly manifestHash: string;
  readonly generation: number;
  readonly chunkCount: 1_120;
  readonly sourceCount: 1_120;
  readonly threadCount: 160;
  readonly accountCount: 7;
  readonly brandCount: 2;
  readonly channelCounts: typeof hostedEvaluatorChannelCountsV2;
  readonly brandCounts: typeof hostedEvaluatorBrandCountsV2;
}

export class EvaluatorRetrievalSeedError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'EvaluatorRetrievalSeedError';
  }
}

class PreviewArtifactStore implements ImmutableRetrievalArtifactStore {
  readonly #objects = new Map<string, Uint8Array>();

  public putImmutableObject(input: {
    readonly tenantId: string;
    readonly scopeHash: string;
    readonly namespace: 'retrieval-staged' | 'retrieval-snapshots';
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    const contentHash = sha256Bytes(input.bytes);
    const objectKey = `${input.namespace}/${input.scopeHash}/${contentHash}`;
    this.#objects.set(objectKey, new Uint8Array(input.bytes));
    return Promise.resolve(
      immutableBlobRefSchema.parse({
        schemaVersion: '1',
        tenantId: input.tenantId,
        bucketRef: 'deterministic-seed-preview',
        objectKey,
        objectVersion: contentHash,
        contentHash,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        encryptionKeyRef: 'deterministic-seed-preview',
        retentionPolicyVersion: '1',
      }),
    );
  }

  public getImmutableObject(ref: ImmutableBlobRef): Promise<Uint8Array> {
    const bytes = this.#objects.get(ref.objectKey);
    if (bytes === undefined)
      return Promise.reject(
        new EvaluatorRetrievalSeedError('SEED_PREVIEW_OBJECT_MISSING'),
      );
    return Promise.resolve(new Uint8Array(bytes));
  }
}

async function canonicalSeedWrites(): Promise<
  readonly {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }[]
> {
  const workItems = buildHostedEvaluatorCorpusV2().workItems;
  const store = new InMemoryIngestionStore();
  const pipeline = new CanonicalIngestionPipeline({
    store,
    keyCodec: new KeyCodec({
      current: {
        version: 'deterministic_evaluator_seed_v1',
        secret: new Uint8Array(32).fill(NON_SECRET_DIGEST_BYTE),
      },
    }),
    retrievalSink: new DeterministicRetrievalMutationSink(),
    retrievalRegistrar: new RecordingRetrievalIndex(),
    now: () => new Date(HOSTED_CORPUS_SEED_AT),
  });
  let processed = 0;
  for (let offset = 0; offset < workItems.length; offset += 1_000) {
    const event: IngestionEvent = {
      schemaVersion: '1',
      invocationId: `deterministic-evaluator-retrieval-seed-v2-${String(
        offset / 1_000 + 1,
      )}`,
      receivedAt: HOSTED_CORPUS_SEED_AT,
      workItems: workItems.slice(offset, offset + 1_000),
    };
    const result = await pipeline.process(event);
    if (result.status !== 'complete' || result.quarantined !== 0)
      throw new EvaluatorRetrievalSeedError('SEED_CANONICALIZATION_FAILED');
    processed += result.processed;
  }
  if (
    processed !== workItems.length ||
    store.writes.length !== workItems.length
  )
    throw new EvaluatorRetrievalSeedError('SEED_CANONICALIZATION_FAILED');
  const writes = store.writes.map((write, index) => ({
    workItem: workItems[index] as IngestionWorkItem,
    canonical: write.canonical,
  }));
  for (const anchor of deterministicEvaluatorIdentityV2.anchorOverlays) {
    const write = writes.find(
      ({ workItem }) =>
        workItem.record.kind === 'gmail' &&
        workItem.record.id === anchor.providerMessageId,
    );
    if (
      write === undefined ||
      write.canonical.source === 'asana' ||
      write.canonical.thread.threadId !== anchor.retrievalExactEntityRef
    )
      throw new EvaluatorRetrievalSeedError('SEED_IDENTITY_DRIFT');
  }
  return Object.freeze(writes);
}

function withoutSchemaVersion(
  record: ReturnType<typeof parseStagedMutationObject>['record'],
): ProjectionRecord {
  return {
    chunkId: record.chunkId,
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    text: record.text,
    tokenCount: record.tokenCount,
    exactEntityRefs: record.exactEntityRefs,
    citationLabel: record.citationLabel,
    contentHash: record.contentHash,
    state: record.state,
    mutationOrdinal: record.mutationOrdinal,
    sourceAuthority: parseProjectionSourceAuthority(record.sourceAuthority),
  };
}

async function expectedDocuments(
  writes: readonly {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }[],
  producer: DeterministicEffectDisabledEmbedding,
): Promise<readonly StagedMutationDocumentV1[]> {
  const preview = new PreviewArtifactStore();
  const writer = new S3RetrievalMutationSink(preview, producer);
  const documents: StagedMutationDocumentV1[] = [];
  for (const write of writes) {
    const manifest = await writer.stage(write);
    const bytes = await preview.getImmutableObject(manifest.object);
    documents.push(
      parseStagedMutationObject(
        bytes,
        manifest.stagingOrdinal,
        producer.dimension,
      ),
    );
  }
  return Object.freeze(
    documents.sort((left, right) =>
      left.record.chunkId.localeCompare(right.record.chunkId),
    ),
  );
}

async function snapshotRecords(
  artifacts: ImmutableRetrievalArtifactStore,
  head: Awaited<ReturnType<DurableRetrievalHeadStore['getHead']>>,
): Promise<readonly ProjectionRecord[]> {
  if (head === undefined) return [];
  const records: ProjectionRecord[] = [];
  for (const shard of head.manifest.shards) {
    records.push(
      ...readProjectionRecords(
        await artifacts.getImmutableObject(shard.chunkIdObject),
      ),
    );
  }
  return Object.freeze(
    records.sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
  );
}

function assertSeedSubset(
  observed: readonly ProjectionRecord[],
  expected: readonly ProjectionRecord[],
  driftCode: string,
): void {
  const expectedByChunk = new Map(
    expected.map((record) => [record.chunkId, canonicalJson(record)]),
  );
  for (const record of observed) {
    if (expectedByChunk.get(record.chunkId) !== canonicalJson(record))
      throw new EvaluatorRetrievalSeedError(driftCode);
  }
}

function assertStagedSeedSubset(
  observed: readonly StagedMutationDocumentV1[],
  expected: readonly StagedMutationDocumentV1[],
): void {
  const expectedByChunk = new Map(
    expected.map((document) => [
      document.record.chunkId,
      canonicalJson(document),
    ]),
  );
  for (const document of observed) {
    if (
      expectedByChunk.get(document.record.chunkId) !== canonicalJson(document)
    )
      throw new EvaluatorRetrievalSeedError('SEED_CATALOG_DRIFT');
  }
}

async function stagedDocuments(
  dependencies: EvaluatorRetrievalSeedDependencies,
  producer: DeterministicEffectDisabledEmbedding,
): Promise<readonly StagedMutationDocumentV1[]> {
  const staged = await listBoundedStagedRetrieval({
    catalog: dependencies.authority,
    scope: evaluatorRetrievalScope,
  });
  const documents: StagedMutationDocumentV1[] = [];
  for (const manifest of staged) {
    const bytes = await dependencies.artifacts.getImmutableObject(
      manifest.object,
    );
    documents.push(
      parseStagedMutationObject(
        bytes,
        manifest.stagingOrdinal,
        producer.dimension,
      ),
    );
  }
  return Object.freeze(documents);
}

async function assertSnapshotVectors(
  artifacts: ImmutableRetrievalArtifactStore,
  head: NonNullable<Awaited<ReturnType<DurableRetrievalHeadStore['getHead']>>>,
  producer: DeterministicEffectDisabledEmbedding,
): Promise<void> {
  for (const shard of head.manifest.shards) {
    const [recordBytes, vectorBytes] = await Promise.all([
      artifacts.getImmutableObject(shard.chunkIdObject),
      artifacts.getImmutableObject(shard.vectorObject),
    ]);
    const records = readProjectionRecords(recordBytes);
    const vectors = decodeBinary32Vectors(
      vectorBytes,
      shard.chunkCount,
      producer.dimension,
    );
    for (const [index, record] of records.entries()) {
      const observed = vectors[index];
      const expected = producer.embed(record.text);
      if (
        observed === undefined ||
        observed.length !== expected.length ||
        !observed.every((value, offset) => Object.is(value, expected[offset]))
      )
        throw new EvaluatorRetrievalSeedError('SEED_SNAPSHOT_VECTOR_DRIFT');
    }
  }
}

function sameScope(left: RetrievalScope, right: RetrievalScope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function seedEvaluatorRetrieval(
  dependencies: EvaluatorRetrievalSeedDependencies,
): Promise<EvaluatorRetrievalSeedResult> {
  const memory = dependencies.memory.sample();
  if (
    !Number.isFinite(memory.rssBytes) ||
    !Number.isFinite(memory.limitBytes) ||
    memory.rssBytes < 0 ||
    memory.limitBytes <= 0 ||
    memory.rssBytes / memory.limitBytes >= 0.6
  )
    throw new EvaluatorRetrievalSeedError('SEED_MEMORY_LIMIT');
  const epoch = await dependencies.readAuthorizationEpoch();
  if (
    epoch !== undefined &&
    epoch !== evaluatorRetrievalScope.authorizationEpoch
  )
    throw new EvaluatorRetrievalSeedError('SEED_AUTHORIZATION_EPOCH_DRIFT');
  const producer = new DeterministicEffectDisabledEmbedding();
  const writes = await canonicalSeedWrites();
  const expectedDocumentsValue = await expectedDocuments(writes, producer);
  const expected = expectedDocumentsValue.map(({ record }) =>
    withoutSchemaVersion(record),
  );
  if (expected.length !== deterministicEvaluatorIdentityV2.corpus.messageCount)
    throw new EvaluatorRetrievalSeedError('SEED_CORPUS_INVALID');
  let head;
  try {
    head = await dependencies.authority.getHead(evaluatorRetrievalScope);
  } catch (error) {
    if (error instanceof BoundedRetrievalError)
      throw new EvaluatorRetrievalSeedError('SEED_HEAD_DRIFT');
    throw error;
  }
  if (head !== undefined && !sameScope(head.scope, evaluatorRetrievalScope))
    throw new EvaluatorRetrievalSeedError('SEED_HEAD_SCOPE_DRIFT');

  if (head !== undefined) {
    await createBoundedSnapshotValidator({
      artifacts: dependencies.artifacts,
      memory: dependencies.memory,
    })(evaluatorRetrievalScope, head.manifest);
    await assertSnapshotVectors(dependencies.artifacts, head, producer);
  }
  const before = await snapshotRecords(dependencies.artifacts, head);
  assertSeedSubset(before, expected, 'SEED_SNAPSHOT_DRIFT');
  const registered = await stagedDocuments(dependencies, producer);
  if (epoch === undefined && registered.length > 0)
    throw new EvaluatorRetrievalSeedError('SEED_CATALOG_WITHOUT_AUTHORITY');
  assertStagedSeedSubset(registered, expectedDocumentsValue);

  const wasComplete = canonicalJson(before) === canonicalJson(expected);
  const compactor = new DurableRetrievalCompactor({
    artifacts: dependencies.artifacts,
    heads: dependencies.authority,
    memory: dependencies.memory,
    embeddingProfileManifestHash: producer.profileManifestHash,
    embeddingProfileId: producer.profileId,
    vectorDimension: producer.dimension,
    now: () => new Date(HOSTED_CORPUS_SEED_AT),
  });
  const writer = new S3RetrievalMutationSink(
    dependencies.artifacts,
    producer,
    evaluatorRetrievalScope,
  );
  for (let offset = 0; offset < writes.length; offset += 16) {
    const batch = writes.slice(offset, offset + 16);
    await Promise.all(
      batch.map(async (write) => {
        await dependencies.authority.register(await writer.stage(write));
      }),
    );
  }
  const completeStaged = await listBoundedStagedRetrieval({
    catalog: dependencies.authority,
    scope: evaluatorRetrievalScope,
  });
  if (completeStaged.length !== expectedDocumentsValue.length)
    throw new EvaluatorRetrievalSeedError('SEED_CATALOG_PARTIAL');
  let compacted = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentHead = await dependencies.authority.getHead(
      evaluatorRetrievalScope,
    );
    try {
      await compactor.compactAndPromote({
        scope: evaluatorRetrievalScope,
        staged: completeStaged,
        ...(currentHead === undefined
          ? {}
          : {
              expectedHeadManifestHash: currentHead.manifest.manifestHash,
            }),
      });
      compacted = true;
      break;
    } catch (error) {
      if (
        !(error instanceof BoundedRetrievalError) ||
        error.code !== 'INDEX_REFRESH_REQUIRED' ||
        attempt === 2
      )
        throw error;
    }
  }
  if (!compacted)
    throw new EvaluatorRetrievalSeedError('SEED_COMPACTION_FAILED');

  const finalEpoch = await dependencies.readAuthorizationEpoch();
  if (finalEpoch !== evaluatorRetrievalScope.authorizationEpoch)
    throw new EvaluatorRetrievalSeedError('SEED_AUTHORIZATION_EPOCH_DRIFT');
  const finalHead = await dependencies.authority.getHead(
    evaluatorRetrievalScope,
  );
  if (
    finalHead === undefined ||
    !sameScope(finalHead.scope, evaluatorRetrievalScope)
  )
    throw new EvaluatorRetrievalSeedError('SEED_HEAD_MISSING');
  await createBoundedSnapshotValidator({
    artifacts: dependencies.artifacts,
    memory: dependencies.memory,
  })(evaluatorRetrievalScope, finalHead.manifest);
  await assertSnapshotVectors(dependencies.artifacts, finalHead, producer);
  const finalRecords = await snapshotRecords(dependencies.artifacts, finalHead);
  if (canonicalJson(finalRecords) !== canonicalJson(expected))
    throw new EvaluatorRetrievalSeedError('SEED_FINAL_SNAPSHOT_DRIFT');
  if (
    finalHead.manifest.chunkCount !==
      deterministicEvaluatorIdentityV2.corpus.messageCount ||
    finalHead.manifest.sourceCount !==
      deterministicEvaluatorIdentityV2.corpus.messageCount
  )
    throw new EvaluatorRetrievalSeedError('SEED_FINAL_IDENTITY_DRIFT');

  return Object.freeze({
    schemaVersion: '1',
    seedVersion: SEED_VERSION,
    seedId: evaluatorRetrievalSeedId,
    status: wasComplete ? 'already_current' : 'seeded',
    scopeHash: evaluatorRetrievalScope.scopeHash,
    authorizationEpoch: 1,
    manifestHash: finalHead.manifest.manifestHash,
    generation: finalHead.generation,
    chunkCount: deterministicEvaluatorIdentityV2.corpus.messageCount,
    sourceCount: deterministicEvaluatorIdentityV2.corpus.messageCount,
    threadCount: deterministicEvaluatorIdentityV2.corpus.threadCount,
    accountCount: deterministicEvaluatorIdentityV2.corpus.accountCount,
    brandCount: deterministicEvaluatorIdentityV2.corpus.brandCount,
    channelCounts: hostedEvaluatorChannelCountsV2,
    brandCounts: hostedEvaluatorBrandCountsV2,
  });
}

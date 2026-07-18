import { createHash } from 'node:crypto';

import {
  deterministicEvaluatorIdentityV1,
  immutableBlobRefSchema,
  type ConnectorSnapshot,
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

import {
  CompactingRetrievalRegistrar,
  S3RetrievalMutationSink,
} from '../aws-composition.js';
import {
  DeterministicRetrievalMutationSink,
  InMemoryIngestionStore,
  RecordingRetrievalIndex,
} from '../memory-store.js';
import { CanonicalIngestionPipeline } from '../pipeline.js';
import type {
  CanonicalWrite,
  GmailRecord,
  IngestionEvent,
  IngestionWorkItem,
} from '../types.js';

const SEED_AT = '2026-07-17T12:00:00.000Z';
const SEED_VERSION = 'chief-evaluator-retrieval-seed.v1';
const NON_SECRET_DIGEST_BYTE = 71;

export const evaluatorRetrievalScope = retrievalScopeSchema.parse({
  derivation: 'server_grants',
  tenantId: deterministicEvaluatorIdentityV1.tenantId,
  accountIds: [deterministicEvaluatorIdentityV1.accountId],
  brandIds: [deterministicEvaluatorIdentityV1.brandId],
  authorizationEpoch: deterministicEvaluatorIdentityV1.authorizationEpoch,
  scopeHash: deterministicEvaluatorIdentityV1.scopeHash,
  role: 'factual',
});

const corpus = Object.freeze([
  Object.freeze({
    providerMessageId: 'evaluator-message-1',
    providerThreadId: 'evaluator-thread-1',
    sourceTimestamp: '2026-07-17T10:52:00.000Z',
    sender: 'synthetic-jordan@example.invalid',
    subject: 'Friday launch decision',
    body: 'Can we confirm the Friday launch and the owner for QA? The Friday launch decision is pending confirmation of the QA owner.',
  }),
  Object.freeze({
    providerMessageId: 'evaluator-message-2',
    providerThreadId: 'evaluator-thread-2',
    sourceTimestamp: '2026-07-17T11:06:00.000Z',
    sender: 'synthetic-priya@example.invalid',
    subject: 'Board update numbers',
    body: 'Please send the approved pipeline numbers for the board note.',
  }),
]);

export const evaluatorRetrievalSeedId = sha256Bytes(
  canonicalJson({
    seedVersion: SEED_VERSION,
    identity: deterministicEvaluatorIdentityV1,
    scope: evaluatorRetrievalScope,
    corpus,
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
  readonly chunkCount: 2;
  readonly sourceCount: 2;
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function workItem(
  item: (typeof corpus)[number],
  index: number,
): IngestionWorkItem {
  const record: GmailRecord = {
    kind: 'gmail',
    id: item.providerMessageId,
    threadId: item.providerThreadId,
    internalDate: String(Date.parse(item.sourceTimestamp)),
    labels: ['INBOX'],
    direction: 'inbound',
    headers: {
      From: item.sender,
      To: 'public-evaluator@example.invalid',
      Subject: item.subject,
    },
    textBody: item.body,
    attachments: [],
  };
  const serializedRecord = canonicalJson(record);
  const rawContentHash = sha256(serializedRecord);
  const connectorSnapshot: ConnectorSnapshot = {
    connectorId: deterministicEvaluatorIdentityV1.connector.connectorId,
    descriptorVersion:
      deterministicEvaluatorIdentityV1.connector.descriptorVersion,
    accountId: deterministicEvaluatorIdentityV1.accountId,
    capabilitySnapshotHash:
      deterministicEvaluatorIdentityV1.connector.capabilitySnapshotHash,
    runtimeMode: deterministicEvaluatorIdentityV1.connector.runtimeMode,
    selectionState: 'selected',
  };
  return {
    schemaVersion: '1',
    workItemId: `evaluator-seed-work-${String(index + 1)}`,
    source: 'gmail',
    tenantId: deterministicEvaluatorIdentityV1.tenantId,
    accountId: deterministicEvaluatorIdentityV1.accountId,
    connectorSnapshot,
    rawReference: immutableBlobRefSchema.parse({
      schemaVersion: '1',
      tenantId: deterministicEvaluatorIdentityV1.tenantId,
      bucketRef: 'deterministic-evaluator-fixture',
      objectKey: `synthetic/gmail/${item.providerMessageId}`,
      objectVersion: rawContentHash,
      contentHash: rawContentHash,
      byteLength: new TextEncoder().encode(serializedRecord).byteLength,
      mediaType: 'application/json',
      encryptionKeyRef: 'deterministic-evaluator-fixture',
      retentionPolicyVersion: '1',
    }),
    record,
    authorizationEpoch: evaluatorRetrievalScope.authorizationEpoch,
    scopeHash: evaluatorRetrievalScope.scopeHash,
    brandIds: [deterministicEvaluatorIdentityV1.brandId],
  };
}

async function canonicalSeedWrites(): Promise<
  readonly {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }[]
> {
  const workItems = corpus.map(workItem);
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
    now: () => new Date(SEED_AT),
  });
  const event: IngestionEvent = {
    schemaVersion: '1',
    invocationId: 'deterministic-evaluator-retrieval-seed-v1',
    receivedAt: SEED_AT,
    workItems,
  };
  const result = await pipeline.process(event);
  if (
    result.status !== 'complete' ||
    result.quarantined !== 0 ||
    store.writes.length !== corpus.length
  )
    throw new EvaluatorRetrievalSeedError('SEED_CANONICALIZATION_FAILED');
  return store.writes.map((write, index) => {
    const identity = deterministicEvaluatorIdentityV1.communications[index];
    if (
      identity === undefined ||
      write.canonical.source === 'asana' ||
      write.canonical.thread.threadId !== identity.retrievalExactEntityRef
    )
      throw new EvaluatorRetrievalSeedError('SEED_IDENTITY_DRIFT');
    return {
      workItem: workItems[index] as IngestionWorkItem,
      canonical: write.canonical,
    };
  });
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
  const producer = new DeterministicEffectDisabledEmbedding();
  const writes = await canonicalSeedWrites();
  const expectedDocumentsValue = await expectedDocuments(writes, producer);
  const expected = expectedDocumentsValue.map(({ record }) =>
    withoutSchemaVersion(record),
  );
  if (expected.length !== 2)
    throw new EvaluatorRetrievalSeedError('SEED_CORPUS_INVALID');
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
    now: () => new Date(SEED_AT),
  });
  const registrar = new CompactingRetrievalRegistrar(
    dependencies.authority,
    compactor,
  );
  const writer = new S3RetrievalMutationSink(dependencies.artifacts, producer);
  for (const write of writes) {
    await registrar.register(await writer.stage(write));
  }

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
    finalHead.manifest.chunkCount !== 2 ||
    finalHead.manifest.sourceCount !== 2
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
    chunkCount: 2,
    sourceCount: 2,
  });
}

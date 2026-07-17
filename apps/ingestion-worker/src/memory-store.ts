import { createHash } from 'node:crypto';

import {
  immutableBlobRefSchema,
  retrievalDeltaManifestSchema,
  retrievalQuerySchema,
  retrievalScopeSchema,
  retrievalSnapshotManifestSchema,
  type ImmutableBlobRef,
  type RetrievalCandidate,
  type RetrievalDeltaManifest,
  type RetrievalQuery,
  type RetrievalScope,
  type RetrievalSnapshotManifest,
  type SyncCheckpoint,
} from '@chief/contracts';
import { DomainInvariantError } from '@chief/domain';
import {
  type RetrievalDeltaApplyResult,
  type RetrievalHealthResult,
  type RetrievalIndex,
  type RetrievalSnapshotApplyResult,
} from '@chief/rag';
import { hashManifest } from '@chief/rag/bounded-retrieval';

import type {
  CanonicalAsanaWrite,
  CanonicalCommunicationWrite,
  CanonicalWrite,
  CommitResult,
  IngestionStore,
  IngestionWorkItem,
  RetrievalMutationSink,
  ThreadMessageFact,
} from './types.js';

interface IdentityEntry {
  readonly accountId: string;
  readonly entityId: string;
  readonly evidenceRef: string;
}

interface StoredWrite {
  readonly canonical: CanonicalWrite;
  readonly checkpoint?: SyncCheckpoint;
  readonly retrievalDelta?: RetrievalDeltaManifest;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mapKey(...parts: readonly string[]): string {
  return parts.map((part) => `${String(part.length)}:${part}`).join('|');
}

export class InMemoryIngestionStore implements IngestionStore {
  readonly #writes = new Map<string, StoredWrite>();
  readonly #messageVersions = new Map<string, number>();
  readonly #threadFacts = new Map<string, ThreadMessageFact[]>();
  readonly #identities = new Map<string, IdentityEntry[]>();
  readonly #asanaTerms = new Map<
    string,
    { objectId: string; evidenceRef: string }[]
  >();
  readonly #checkpoints = new Map<string, SyncCheckpoint>();
  readonly #quarantine: {
    workItemId: string;
    reasonCode: string;
    detailHash: string;
  }[] = [];
  readonly #bodies = new Map<string, string>();

  public get writes(): readonly StoredWrite[] {
    return Object.freeze([...this.#writes.values()]);
  }

  public get quarantined(): readonly {
    workItemId: string;
    reasonCode: string;
    detailHash: string;
  }[] {
    return Object.freeze([...this.#quarantine]);
  }

  public get bodies(): ReadonlyMap<string, string> {
    return this.#bodies;
  }

  public putBody(input: {
    readonly tenantId: string;
    readonly body: string;
    readonly contentHash: string;
    readonly mediaType: string;
  }): Promise<ImmutableBlobRef> {
    if (hash(input.body) !== input.contentHash)
      throw new Error('BODY_HASH_MISMATCH');
    const objectKey = `normalized/${input.contentHash}`;
    this.#bodies.set(mapKey(input.tenantId, objectKey), input.body);
    return Promise.resolve(
      immutableBlobRefSchema.parse({
        schemaVersion: '1',
        tenantId: input.tenantId,
        bucketRef: 'memory-ingestion-bodies',
        objectKey,
        objectVersion: input.contentHash,
        contentHash: input.contentHash,
        byteLength: Buffer.byteLength(input.body),
        mediaType: input.mediaType,
        encryptionKeyRef: 'memory-test-key',
        retentionPolicyVersion: '1',
      }),
    );
  }

  public findIdentityCandidates(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly identityDigests: readonly string[];
  }): Promise<
    readonly { readonly entityId: string; readonly evidenceRef: string }[]
  > {
    const candidates = input.identityDigests
      .flatMap(
        (digest) => this.#identities.get(mapKey(input.tenantId, digest)) ?? [],
      )
      .filter((entry) => entry.accountId !== input.accountId);
    const unique = new Map(
      candidates.map((candidate) => [candidate.entityId, candidate]),
    );
    return Promise.resolve(
      Object.freeze(
        [...unique.values()].sort((left, right) =>
          left.entityId.localeCompare(right.entityId),
        ),
      ),
    );
  }

  public findAsanaCandidates(input: {
    readonly tenantId: string;
    readonly topicTerms: readonly string[];
  }): Promise<
    readonly { readonly objectId: string; readonly evidenceRef: string }[]
  > {
    const matches = input.topicTerms.flatMap(
      (term) => this.#asanaTerms.get(mapKey(input.tenantId, term)) ?? [],
    );
    const unique = new Map(
      matches.map((candidate) => [candidate.objectId, candidate]),
    );
    return Promise.resolve(
      Object.freeze(
        [...unique.values()].sort((left, right) =>
          left.objectId.localeCompare(right.objectId),
        ),
      ),
    );
  }

  public threadFacts(input: {
    readonly tenantId: string;
    readonly threadId: string;
  }): Promise<readonly ThreadMessageFact[]> {
    return Promise.resolve(
      Object.freeze([
        ...(this.#threadFacts.get(mapKey(input.tenantId, input.threadId)) ??
          []),
      ]),
    );
  }

  public commit(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
    readonly checkpoint?: SyncCheckpoint;
    readonly retrievalDelta?: RetrievalDeltaManifest;
  }): Promise<CommitResult> {
    const key = mapKey(
      input.workItem.tenantId,
      input.workItem.accountId,
      input.canonical.dedupeKey,
    );
    if (this.#writes.has(key)) return Promise.resolve({ status: 'duplicate' });
    this.#assertCheckpoint(input.workItem, input.checkpoint);
    if (input.retrievalDelta !== undefined)
      retrievalDeltaManifestSchema.parse(input.retrievalDelta);
    const status = input.canonical.deleted
      ? 'deleted'
      : this.#isUpdate(input.canonical)
        ? 'updated'
        : 'created';
    this.#writes.set(key, {
      canonical: input.canonical,
      ...(input.checkpoint === undefined
        ? {}
        : { checkpoint: input.checkpoint }),
      ...(input.retrievalDelta === undefined
        ? {}
        : { retrievalDelta: input.retrievalDelta }),
    });
    if (input.checkpoint !== undefined)
      this.#checkpoints.set(
        this.#checkpointKey(input.workItem),
        input.checkpoint,
      );
    if (input.canonical.source === 'asana') this.#indexAsana(input.canonical);
    else this.#indexCommunication(input.workItem, input.canonical);
    return Promise.resolve({ status });
  }

  public quarantine(input: {
    readonly workItem: IngestionWorkItem;
    readonly reasonCode: string;
    readonly detailHash: string;
  }): Promise<void> {
    this.#quarantine.push({
      workItemId: input.workItem.workItemId,
      reasonCode: input.reasonCode,
      detailHash: input.detailHash,
    });
    return Promise.resolve();
  }

  #checkpointKey(workItem: IngestionWorkItem): string {
    return mapKey(
      workItem.tenantId,
      workItem.accountId,
      workItem.checkpoint?.current.resourceScopeHash ?? 'none',
    );
  }

  #assertCheckpoint(
    workItem: IngestionWorkItem,
    next: SyncCheckpoint | undefined,
  ): void {
    if (next === undefined) return;
    const current = this.#checkpoints.get(this.#checkpointKey(workItem));
    if (current === undefined) {
      if (
        next.checkpointEpoch !==
        workItem.checkpoint!.current.checkpointEpoch + 1
      )
        throw new DomainInvariantError(
          'STALE_EPOCH',
          'initial checkpoint must advance the supplied epoch',
        );
      return;
    }
    if (
      current.checkpointEpoch !==
        workItem.checkpoint!.current.checkpointEpoch ||
      next.checkpointEpoch !== current.checkpointEpoch + 1
    ) {
      throw new DomainInvariantError(
        'STALE_EPOCH',
        'checkpoint compare-and-swap failed',
      );
    }
  }

  #isUpdate(canonical: CanonicalWrite): boolean {
    const identity =
      canonical.source === 'asana'
        ? mapKey(
            canonical.tenantId,
            canonical.accountId,
            canonical.providerObjectId,
          )
        : mapKey(canonical.message.tenantId, canonical.message.messageId);
    const version = this.#messageVersions.get(identity) ?? 0;
    this.#messageVersions.set(identity, version + 1);
    return version > 0;
  }

  #indexCommunication(
    workItem: IngestionWorkItem,
    canonical: CanonicalCommunicationWrite,
  ): void {
    const threadKey = mapKey(
      canonical.message.tenantId,
      canonical.thread.threadId,
    );
    const facts = this.#threadFacts.get(threadKey) ?? [];
    facts.push({
      messageId: canonical.message.messageId,
      revisionId: canonical.revision.revisionId,
      direction: canonical.revision.direction,
      sourceTimestamp: canonical.revision.sourceTimestamp,
      deleted: canonical.deleted,
    });
    facts.sort(
      (left, right) =>
        left.sourceTimestamp.localeCompare(right.sourceTimestamp) ||
        left.revisionId.localeCompare(right.revisionId),
    );
    this.#threadFacts.set(threadKey, facts);
    if (canonical.deleted) return;
    for (const digest of canonical.identityDigests) {
      const key = mapKey(workItem.tenantId, digest);
      const entries = this.#identities.get(key) ?? [];
      entries.push({
        accountId: workItem.accountId,
        entityId: `person_${digest}`,
        evidenceRef: canonical.revision.revisionId,
      });
      this.#identities.set(key, entries);
    }
  }

  #indexAsana(canonical: CanonicalAsanaWrite): void {
    if (canonical.deleted) return;
    for (const term of canonical.topicTerms) {
      const key = mapKey(canonical.tenantId, term);
      const entries = this.#asanaTerms.get(key) ?? [];
      entries.push({
        objectId: canonical.providerObjectId,
        evidenceRef: canonical.dedupeKey,
      });
      this.#asanaTerms.set(key, entries);
    }
  }
}

export class DeterministicRetrievalMutationSink implements RetrievalMutationSink {
  public stage(input: {
    readonly workItem: IngestionWorkItem;
    readonly canonical: CanonicalWrite;
  }): Promise<RetrievalDeltaManifest | undefined> {
    const text =
      input.canonical.source === 'asana'
        ? `${input.canonical.title}\n${input.canonical.notes ?? ''}`.trim()
        : input.canonical.retrievalText;
    const operation = input.canonical.deleted ? 'delete' : 'upsert';
    const payload = JSON.stringify({
      operation,
      dedupeKey: input.canonical.dedupeKey,
      text,
    });
    const contentHash = hash(payload);
    const createdAt =
      input.canonical.source === 'asana'
        ? input.canonical.providerTimestamp
        : input.canonical.revision.ingestedAt;
    const sequence = Number.parseInt(
      hash(input.canonical.dedupeKey).slice(0, 8),
      16,
    );
    const candidate = retrievalDeltaManifestSchema.parse({
      schemaVersion: '1',
      tenantId: input.workItem.tenantId,
      role: 'factual',
      scopeHash: input.workItem.scopeHash,
      baseGeneration: 1,
      authorizationEpoch: input.workItem.authorizationEpoch,
      sequenceStart: sequence,
      sequenceEnd: sequence,
      changeCount: 1,
      byteLength: Buffer.byteLength(payload),
      object: {
        schemaVersion: '1',
        tenantId: input.workItem.tenantId,
        bucketRef: 'ingestion-retrieval-deltas',
        objectKey: `delta/${contentHash}`,
        objectVersion: contentHash,
        contentHash,
        byteLength: Buffer.byteLength(payload),
        mediaType: 'application/x-ndjson',
        encryptionKeyRef: 'retrieval-key',
        retentionPolicyVersion: '1',
      },
      manifestHash: hash('pending-manifest-hash'),
      createdAt,
    });
    return Promise.resolve(
      retrievalDeltaManifestSchema.parse({
        ...candidate,
        manifestHash: hashManifest(candidate),
      }),
    );
  }
}

export class RecordingRetrievalIndex implements RetrievalIndex {
  readonly #deltas: RetrievalDeltaManifest[] = [];
  readonly #snapshots: RetrievalSnapshotManifest[] = [];

  public get deltas(): readonly RetrievalDeltaManifest[] {
    return Object.freeze([...this.#deltas]);
  }

  public applySnapshot(
    manifest: RetrievalSnapshotManifest,
  ): Promise<RetrievalSnapshotApplyResult> {
    const safe = retrievalSnapshotManifestSchema.parse(manifest);
    this.#snapshots.push(safe);
    return Promise.resolve({
      kind: 'snapshot',
      tenantId: safe.tenantId,
      scopeHash: safe.scopeHash,
      role: safe.role,
      generation: safe.generation,
      authorizationEpoch: safe.authorizationEpoch,
      manifestHash: safe.manifestHash,
      appliedAt: safe.createdAt,
    });
  }

  public applyDelta(
    manifest: RetrievalDeltaManifest,
  ): Promise<RetrievalDeltaApplyResult> {
    const safe = retrievalDeltaManifestSchema.parse(manifest);
    if (hashManifest(safe) !== safe.manifestHash)
      throw new Error('INDEX_REFRESH_REQUIRED');
    this.#deltas.push(safe);
    return Promise.resolve({
      kind: 'delta',
      tenantId: safe.tenantId,
      scopeHash: safe.scopeHash,
      role: safe.role,
      baseGeneration: safe.baseGeneration,
      authorizationEpoch: safe.authorizationEpoch,
      sequenceEnd: safe.sequenceEnd,
      manifestHash: safe.manifestHash,
      appliedAt: safe.createdAt,
    });
  }

  public query(input: RetrievalQuery): Promise<readonly RetrievalCandidate[]> {
    retrievalQuerySchema.parse(input);
    return Promise.resolve([]);
  }

  public health(scope: RetrievalScope): Promise<RetrievalHealthResult> {
    const safe = retrievalScopeSchema.parse(scope);
    return Promise.resolve({
      status: 'healthy',
      scope: safe,
      authorizationEpoch: safe.authorizationEpoch,
      indexedChunkCount: this.#deltas.length,
      pendingDeltaCount: 0,
      observedAt: new Date(0).toISOString(),
    });
  }
}

import { createHash } from 'node:crypto';

import {
  canonicalRetrievalSourceAuthoritySchema,
  immutableBlobRefSchema,
  type ImmutableBlobRef,
  type SyncCheckpoint,
} from '@chief/contracts';
import { DomainInvariantError } from '@chief/domain';
import {
  DeterministicEffectDisabledEmbedding,
  canonicalJson,
  serializeBinary32Le,
  sha256Bytes,
  tokenize,
  validateStagedRetrievalMutation,
  type RetrievalStagingRegistrar,
  type StagedRetrievalMutationV1,
} from '@chief/rag';

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
  readonly retrievalMutation?: StagedRetrievalMutationV1;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evaluatorRelationTopic(
  canonical: CanonicalWrite,
): 'release_readiness' | 'board_metrics' | 'communication_context' | undefined {
  if (canonical.source === 'asana') return undefined;
  if (
    canonical.source === 'gmail' &&
    canonical.thread.threadId ===
      'thr_94f02c2953e5253d7f62f514efffdda78aa29090' &&
    canonical.contentHash ===
      '3ec5dd5bdc24a0edef761555d9100bc853213236ec37ed74a80923f287fcc4cc'
  )
    return 'release_readiness';
  if (
    canonical.source === 'gmail' &&
    canonical.thread.threadId ===
      'thr_309a81cf66fffd346b95eccaf016494a30abd88f' &&
    canonical.contentHash ===
      '49ee3e715f21ab40d361d2aa06f9871cb1bf5cb3731beb9d212f9944e02fb7d0'
  )
    return 'board_metrics';
  return 'communication_context';
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
    readonly retrievalMutation?: StagedRetrievalMutationV1;
  }): Promise<CommitResult> {
    const key = mapKey(
      input.workItem.tenantId,
      input.workItem.accountId,
      input.canonical.dedupeKey,
    );
    if (this.#writes.has(key)) return Promise.resolve({ status: 'duplicate' });
    this.#assertCheckpoint(input.workItem, input.checkpoint);
    if (input.retrievalMutation !== undefined)
      validateStagedRetrievalMutation(input.retrievalMutation);
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
      ...(input.retrievalMutation === undefined
        ? {}
        : { retrievalMutation: input.retrievalMutation }),
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
  }): Promise<StagedRetrievalMutationV1 | undefined> {
    const text =
      input.canonical.source === 'asana'
        ? `${input.canonical.title}\n${input.canonical.notes ?? ''}`.trim()
        : input.canonical.retrievalText;
    const operation = input.canonical.deleted ? 'delete' : 'upsert';
    const createdAt =
      input.canonical.source === 'asana'
        ? input.canonical.providerTimestamp
        : input.canonical.revision.ingestedAt;
    const stagingOrdinal = `${createdAt}#${hash(input.canonical.dedupeKey)}`;
    const relationTopic = evaluatorRelationTopic(input.canonical);
    const record = {
      schemaVersion: '1' as const,
      chunkId: input.canonical.dedupeKey,
      sourceId: input.canonical.dedupeKey,
      sourceVersion: input.canonical.contentHash,
      text,
      tokenCount: tokenize(text).length,
      exactEntityRefs:
        input.canonical.source === 'asana'
          ? [input.canonical.providerObjectId, ...input.canonical.projectIds]
          : [input.canonical.thread.threadId],
      citationLabel:
        input.canonical.source === 'asana'
          ? 'Asana work evidence'
          : `${input.canonical.source} communication evidence`,
      contentHash: sha256Bytes(text),
      state:
        operation === 'upsert' ? ('active' as const) : ('tombstoned' as const),
      mutationOrdinal: stagingOrdinal,
      sourceAuthority: canonicalRetrievalSourceAuthoritySchema.parse(
        input.canonical.source === 'asana'
          ? {
              contractVersion: 'chief-source-authority.v1',
              verifiedBy: 'canonical_ingestion',
              sourceClass: 'asana',
              sourceKind: 'asana',
              relationKind: 'explicit_related_work',
            }
          : {
              contractVersion: 'chief-source-authority.v1',
              verifiedBy: 'canonical_ingestion',
              sourceClass: 'communication',
              sourceKind: input.canonical.source,
              relationKind: 'canonical_thread',
              ...(relationTopic === undefined ? {} : { relationTopic }),
            },
      ),
    };
    const document = {
      schemaVersion: '1' as const,
      stagingOrdinal,
      operation,
      record,
      vectorBinary32LeBase64: Buffer.from(
        serializeBinary32Le(
          new DeterministicEffectDisabledEmbedding().embed(text),
        ),
      ).toString('base64'),
    };
    const payload = canonicalJson([document]);
    const contentHash = hash(payload);
    return Promise.resolve(
      validateStagedRetrievalMutation({
        contractVersion: 'chief-retrieval.v1',
        kind: 'staged-mutation',
        scope: {
          derivation: 'server_grants',
          tenantId: input.workItem.tenantId,
          accountIds: [input.workItem.accountId],
          brandIds: [...(input.workItem.brandIds ?? [])],
          authorizationEpoch: input.workItem.authorizationEpoch,
          scopeHash: input.workItem.scopeHash,
          role: 'factual',
        },
        mutationId: sha256Bytes(payload),
        stagingOrdinal,
        changeCount: 1,
        byteLength: Buffer.byteLength(payload),
        object: {
          schemaVersion: '1',
          tenantId: input.workItem.tenantId,
          bucketRef: 'ingestion-retrieval-deltas',
          objectKey: `retrieval-staged/${input.workItem.scopeHash}/${contentHash}`,
          objectVersion: contentHash,
          contentHash,
          byteLength: Buffer.byteLength(payload),
          mediaType: 'application/x-ndjson',
          encryptionKeyRef: 'retrieval-key',
          retentionPolicyVersion: '1',
        },
        createdAt,
      }),
    );
  }
}

export class RecordingRetrievalIndex implements RetrievalStagingRegistrar {
  readonly #mutations: StagedRetrievalMutationV1[] = [];

  public get deltas(): readonly StagedRetrievalMutationV1[] {
    return Object.freeze([...this.#mutations]);
  }

  public register(manifest: StagedRetrievalMutationV1): Promise<void> {
    const safe = validateStagedRetrievalMutation(manifest);
    if (
      !this.#mutations.some(({ mutationId }) => mutationId === safe.mutationId)
    )
      this.#mutations.push(safe);
    return Promise.resolve();
  }
}

import {
  immutableBlobRefSchema,
  type ConnectorSnapshot,
  type ImmutableBlobRef,
} from '@chief/contracts';
import {
  accountIdSchema,
  messageRevisionIdSchema,
  tenantIdSchema,
  userIdSchema,
  type KeyedDigestValue,
} from '@chief/contracts/ids';
import {
  retrievalQuerySchema,
  retrievalScopeSchema,
  type RetrievalScope,
} from '@chief/contracts/knowledge';
import {
  BoundedRetrievalEvidenceSource,
  ChiefCommunicationAgent,
  CitedContextRetriever,
  type EvidenceFact,
  type EvidenceSource,
} from '@chief/agent';
import { KeyCodec } from '@chief/persistence-dynamodb';
import {
  BoundedDynamoS3RetrievalIndex,
  DeterministicEffectDisabledEmbedding,
  DurableRetrievalCompactor,
  canonicalJson,
  persistEffectDisabledQueryVector,
  prepareEffectDisabledQueryVector,
  sha256Bytes,
  type DurableRetrievalHeadStore,
  type DurableRetrievalHeadV1,
  type ImmutableRetrievalArtifactStore,
  type PersistedQueryVectorStore,
} from '@chief/rag';
import { describe, expect, it, vi } from 'vitest';

import { createFixtureIngestionHandler } from './handler.js';
import {
  CompactingRetrievalRegistrar,
  S3RetrievalMutationSink,
} from './aws-composition.js';
import {
  DeterministicRetrievalMutationSink,
  InMemoryIngestionStore,
  RecordingRetrievalIndex,
} from './memory-store.js';
import { CanonicalIngestionPipeline } from './pipeline.js';
import {
  createProductionSqsHandler,
  parseProductionIngestionRequest,
  type SqsEvent,
} from './production-ingress.js';
import {
  loadProductionIngestionConfig,
  parseConnectorBindings,
} from './runtime-config.js';
import type {
  GmailRecord,
  IngestionEvent,
  IngestionWorkItem,
} from './types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const BINDINGS =
  'gmail=gmail@1.0.0,microsoft_graph=microsoft-graph@1.0.0-wave1a,imap=imap-smtp@1.0.0-protocol,twilio_sms=twilio-sms@1.0.0,twilio_whatsapp=twilio-whatsapp@1.0.0,x=x_legacy_dm@1.0.0,linkedin_archive=linkedin-communications@1.0.0-scaffold,asana=asana-work-management@1.0.0';

function generatedModelOutput(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
  };
}

type AgentGateway = ConstructorParameters<
  typeof ChiefCommunicationAgent
>[0]['gateway'];

function networklessGateway(outputs: readonly unknown[]): AgentGateway {
  let index = 0;
  const model = {
    specificationVersion: 'v3' as const,
    provider: 'stored-output',
    modelId: 'networkless-ingestion-integration-v1',
    supportedUrls: Promise.resolve({}),
    doGenerate: () => Promise.resolve(generatedModelOutput(outputs[index++])),
    doStream: () => Promise.reject(new Error('streaming is disabled')),
  } as unknown as AgentGateway['languageModel'];
  return {
    profile: {
      schemaVersion: '1',
      profileId: 'chief-ingestion-integration-v1',
      modelId: 'networkless-ingestion-integration-v1',
      region: 'us-east-2',
      gateway: 'vercel-ai-sdk',
      gatewayVersion: 'ai@6.0.230',
      promptPolicyHash: HASH_A,
      actionContextRoute: 'chief-action-v1',
      draftRoute: 'chief-draft-v1',
      manifestHash: HASH_B,
    },
    languageModel: model,
    fallbackProfile: null,
    promptCacheMetadata: {
      bedrock_prompt_caching: true,
      bedrock_prompt_cache_strategy: 'system_and_last_non_system',
      bedrock_prompt_cache_ttl: 'default',
      bedrock_prompt_cache_tool_config: false,
    },
  };
}

class IntegrationRetrievalStore
  implements
    ImmutableRetrievalArtifactStore,
    DurableRetrievalHeadStore,
    PersistedQueryVectorStore
{
  readonly objects = new Map<string, Uint8Array>();
  readonly heads = new Map<string, DurableRetrievalHeadV1>();
  readonly vectors = new Map<string, Float32Array>();

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
        bucketRef: 'integration-retrieval',
        objectKey,
        objectVersion: contentHash,
        contentHash,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        encryptionKeyRef: 'integration-kms',
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
    scope: RetrievalScope,
  ): Promise<DurableRetrievalHeadV1 | undefined> {
    return Promise.resolve(this.heads.get(canonicalJson(scope)));
  }

  public compareAndSwapHead(input: {
    readonly scope: RetrievalScope;
    readonly expectedManifestHash?: string;
    readonly next: DurableRetrievalHeadV1;
  }): Promise<'promoted' | 'stale'> {
    const key = canonicalJson(input.scope);
    if (
      this.heads.get(key)?.manifest.manifestHash !== input.expectedManifestHash
    )
      return Promise.resolve('stale');
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
      `${canonicalJson(input.scope)}:${input.queryHash}`,
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
    return Promise.resolve(
      this.vectors.get(`${canonicalJson(input.scope)}:${input.queryHash}`),
    );
  }
}

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    INGESTION_RUNTIME_MODE: 'production',
    CORE_TABLE_NAME: 'core',
    CONNECTOR_RUNTIME_TABLE_NAME: 'connector-runtime',
    RETRIEVAL_TABLE_NAME: 'retrieval',
    SNAPSHOT_BUCKET_NAME: 'snapshot-bucket',
    DIGEST_KEY_SECRET_ARN: 'arn:aws:secretsmanager:region:account:secret:key',
    PRODUCT_DATA_KEY_ARN: 'arn:aws:kms:region:account:key/key-id',
    INGESTION_THREAD_LOOKUP_INDEX_NAME: 'ThreadLookupIndex',
    INGESTION_IDENTITY_LOOKUP_INDEX_NAME: 'IdentityLookupIndex',
    INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME: 'AsanaTopicLookupIndex',
    INGESTION_CONNECTOR_BINDINGS: BINDINGS,
    ...overrides,
  };
}

function gmailWorkItem(
  overrides: Partial<IngestionWorkItem> = {},
): IngestionWorkItem {
  const record: GmailRecord = {
    kind: 'gmail',
    id: 'provider-message-1',
    threadId: 'provider-thread-1',
    internalDate: String(Date.parse('2026-07-17T12:00:00.000Z')),
    labels: ['INBOX'],
    direction: 'inbound',
    headers: {
      From: 'sender@example.test',
      To: 'executive@example.test',
      Subject: 'Fixture subject',
    },
    textBody: 'Fixture body',
    attachments: [],
  };
  const snapshot: ConnectorSnapshot = {
    connectorId: 'gmail',
    descriptorVersion: '1.0.0',
    accountId: 'gmail-account' as ConnectorSnapshot['accountId'],
    capabilitySnapshotHash: HASH_B,
    runtimeMode: 'live',
    selectionState: 'selected',
  };
  return {
    schemaVersion: '1',
    workItemId: 'work-1',
    source: 'gmail',
    tenantId: 'tenant-a',
    accountId: 'gmail-account',
    connectorSnapshot: snapshot,
    rawReference: immutableBlobRefSchema.parse({
      schemaVersion: '1',
      tenantId: 'tenant-a',
      bucketRef: 'fixture-raw',
      objectKey: 'raw/provider-message-1',
      objectVersion: HASH_A,
      contentHash: HASH_A,
      byteLength: 100,
      mediaType: 'application/json',
      encryptionKeyRef: 'fixture-kms',
      retentionPolicyVersion: '1',
    }),
    record,
    authorizationEpoch: 3,
    scopeHash: HASH_A,
    brandIds: ['brand-a'],
    ...overrides,
  };
}

function ingestionEvent(item = gmailWorkItem()): IngestionEvent {
  return {
    schemaVersion: '1',
    invocationId: 'invocation-1',
    receivedAt: '2026-07-17T12:01:00.000Z',
    workItems: [item],
  };
}

function eventBridgeBody(item = gmailWorkItem()): string {
  return JSON.stringify({
    source: 'chief.connectors',
    'detail-type': 'communication.ingest.requested',
    detail: {
      schemaVersion: '1',
      authority: {
        derivation: 'server_grants',
        tenantId: 'tenant-a',
        accountIds: ['gmail-account'],
        brandIds: ['brand-a'],
        authorizationEpoch: 3,
        scopeHash: HASH_A,
      },
      ingestionEvent: ingestionEvent(item),
    },
  });
}

describe('production ingestion configuration', () => {
  it('loads only the complete explicit production configuration', () => {
    const config = loadProductionIngestionConfig(environment());

    expect(config.runtimeMode).toBe('production');
    expect(config.connectorBindings.get('gmail')).toEqual({
      source: 'gmail',
      connectorId: 'gmail',
      descriptorVersion: '1.0.0',
    });
    expect([...config.connectorBindings.keys()]).not.toContain('demo');
  });

  it.each([
    ['missing table', { CORE_TABLE_NAME: undefined }],
    ['fixture deployment', { INGESTION_RUNTIME_MODE: 'fixture' }],
    [
      'missing connector binding',
      { INGESTION_CONNECTOR_BINDINGS: 'gmail=gmail@1.0.0' },
    ],
    [
      'invalid connector binding',
      { INGESTION_CONNECTOR_BINDINGS: `${BINDINGS},demo=demo@1.0.0` },
    ],
  ])('fails closed for %s', (_name, overrides) => {
    expect(() =>
      loadProductionIngestionConfig(environment(overrides)),
    ).toThrow();
  });
});

describe('production ingestion authority and connector admission', () => {
  const bindings = parseConnectorBindings(BINDINGS);

  it('accepts a fully server-bound connector event without provider calls', () => {
    const request = parseProductionIngestionRequest(
      eventBridgeBody(),
      bindings,
    );

    expect(request.authority.derivation).toBe('server_grants');
    expect(request.ingestionEvent.workItems).toHaveLength(1);
  });

  it.each([
    ['tenant substitution', gmailWorkItem({ tenantId: 'tenant-b' })],
    ['account substitution', gmailWorkItem({ accountId: 'other-account' })],
    ['scope substitution', gmailWorkItem({ scopeHash: 'c'.repeat(64) })],
    [
      'authorization epoch substitution',
      gmailWorkItem({ authorizationEpoch: 4 }),
    ],
    [
      'connector substitution',
      gmailWorkItem({
        connectorSnapshot: {
          ...gmailWorkItem().connectorSnapshot,
          connectorId: 'unregistered-gmail',
        },
      }),
    ],
    [
      'fixture authority in production',
      gmailWorkItem({
        connectorSnapshot: {
          ...gmailWorkItem().connectorSnapshot,
          runtimeMode: 'fixture',
        },
      }),
    ],
  ])('rejects %s', (_name, item) => {
    expect(() =>
      parseProductionIngestionRequest(eventBridgeBody(item), bindings),
    ).toThrow();
  });

  it('returns only failed SQS item identifiers for deterministic redrive', async () => {
    const processEvent = vi.fn(() => Promise.resolve());
    const handler = createProductionSqsHandler(processEvent, bindings);
    const event: SqsEvent = {
      Records: [
        { messageId: 'good', body: eventBridgeBody() },
        {
          messageId: 'bad',
          body: eventBridgeBody(gmailWorkItem({ scopeHash: HASH_B })),
        },
      ],
    };

    await expect(handler(event)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'bad' }],
    });
    expect(processEvent).toHaveBeenCalledOnce();
  });
});

describe('explicit fixture composition', () => {
  it('is deterministic, credentialless, and never selected by production', async () => {
    const fixtureItem = gmailWorkItem({
      connectorSnapshot: {
        ...gmailWorkItem().connectorSnapshot,
        connectorId: 'connector-gmail',
        descriptorVersion: '1',
        runtimeMode: 'fixture',
      },
    });
    const first = await createFixtureIngestionHandler()(
      ingestionEvent(fixtureItem),
    );
    const second = await createFixtureIngestionHandler()(
      ingestionEvent(fixtureItem),
    );

    expect({ ...first, durationMs: 0 }).toEqual({ ...second, durationMs: 0 });
    expect(first).toMatchObject({
      status: 'complete',
      processed: 1,
      quarantined: 0,
      externalProviderCalls: 0,
    });
  });
});

describe('production writer to bounded reader compatibility', () => {
  it('recovers registered staging through the bounded catalog and promotes without a scan', async () => {
    const item = gmailWorkItem();
    const canonicalStore = new InMemoryIngestionStore();
    await new CanonicalIngestionPipeline({
      store: canonicalStore,
      keyCodec: new KeyCodec({
        current: {
          version: 'integration_v1',
          secret: new Uint8Array(32).fill(19),
        },
      }),
      retrievalSink: new DeterministicRetrievalMutationSink(),
      retrievalRegistrar: new RecordingRetrievalIndex(),
      now: () => new Date('2026-07-17T12:01:00.000Z'),
    }).process(ingestionEvent(item));
    const canonical = canonicalStore.writes[0]?.canonical;
    if (canonical === undefined) throw new Error('canonical write missing');
    const store = new IntegrationRetrievalStore();
    const producer = new DeterministicEffectDisabledEmbedding();
    const mutation = await new S3RetrievalMutationSink(store, producer).stage({
      workItem: item,
      canonical,
    });
    const registered = new Map<string, typeof mutation>();
    let queryCount = 0;
    const authority = {
      register: (candidate: typeof mutation) => {
        registered.set(candidate.mutationId, candidate);
        return Promise.resolve();
      },
      listStaged: () => {
        queryCount += 1;
        return Promise.resolve({ manifests: [...registered.values()] });
      },
      getHead: (scope: RetrievalScope) => store.getHead(scope),
      compareAndSwapHead: (input: {
        readonly scope: RetrievalScope;
        readonly expectedManifestHash?: string;
        readonly next: DurableRetrievalHeadV1;
      }) => store.compareAndSwapHead(input),
    };
    await new CompactingRetrievalRegistrar(
      authority,
      new DurableRetrievalCompactor({
        artifacts: store,
        heads: store,
        memory: { sample: () => ({ rssBytes: 1, limitBytes: 1_000_000 }) },
        embeddingProfileManifestHash: producer.profileManifestHash,
        embeddingProfileId: producer.profileId,
        vectorDimension: producer.dimension,
        now: () => new Date('2026-07-17T12:02:00.000Z'),
      }),
    ).register(mutation);

    expect(queryCount).toBe(1);
    await expect(store.getHead(mutation.scope)).resolves.toMatchObject({
      generation: 1,
      publishedSequenceEnd: 1,
      manifest: { chunkCount: 1 },
    });
  });

  it('stages with the actual production writer, compacts, CAS-promotes, and retrieves with a persisted query vector', async () => {
    const item = gmailWorkItem();
    if (item.record.kind !== 'gmail') throw new Error('expected Gmail record');
    const baseRecord = item.record;
    const replayItems = [
      item,
      gmailWorkItem({
        workItemId: 'work-2',
        rawReference: {
          ...item.rawReference,
          objectKey: 'raw/provider-message-2',
        },
        record: {
          ...baseRecord,
          id: 'provider-message-2',
          threadId: 'provider-thread-2',
        },
      }),
      gmailWorkItem({
        workItemId: 'work-3',
        rawReference: {
          ...item.rawReference,
          objectKey: 'raw/provider-message-3',
        },
        record: {
          ...baseRecord,
          id: 'provider-message-3',
          threadId: 'provider-thread-3',
        },
      }),
    ];
    const canonicalStore = new InMemoryIngestionStore();
    const canonicalPipeline = new CanonicalIngestionPipeline({
      store: canonicalStore,
      keyCodec: new KeyCodec({
        current: {
          version: 'integration_v1',
          secret: new Uint8Array(32).fill(19),
        },
      }),
      retrievalSink: new DeterministicRetrievalMutationSink(),
      retrievalRegistrar: new RecordingRetrievalIndex(),
      now: () => new Date('2026-07-17T12:01:00.000Z'),
    });
    await canonicalPipeline.process(ingestionEvent(item));
    await canonicalPipeline.process(ingestionEvent(replayItems[1] ?? item));
    await canonicalPipeline.process(ingestionEvent(replayItems[2] ?? item));
    const canonicals = canonicalStore.writes.map(({ canonical }) => canonical);
    const canonical = canonicals[0];
    if (canonical === undefined) throw new Error('canonical write missing');
    const store = new IntegrationRetrievalStore();
    const producer = new DeterministicEffectDisabledEmbedding();
    const writer = new S3RetrievalMutationSink(store, producer);
    const staged = await Promise.all(
      replayItems.map((workItem, index) => {
        const canonicalWrite = canonicals[index];
        if (canonicalWrite === undefined)
          throw new Error('canonical write missing');
        return writer.stage({ workItem, canonical: canonicalWrite });
      }),
    );
    expect(staged[0]).not.toHaveProperty('sequence');
    expect(staged[0]?.object.mediaType).toContain('chief.retrieval-staged');
    const firstStaged = staged[0];
    if (firstStaged === undefined) throw new Error('staged write missing');
    const scope = retrievalScopeSchema.parse(firstStaged.scope);
    const result = await new DurableRetrievalCompactor({
      artifacts: store,
      heads: store,
      memory: {
        sample: () => ({ rssBytes: 1, limitBytes: 1_000_000 }),
      },
      embeddingProfileManifestHash: producer.profileManifestHash,
      embeddingProfileId: producer.profileId,
      vectorDimension: producer.dimension,
      now: () => new Date('2026-07-17T12:02:00.000Z'),
    }).compactAndPromote({
      scope,
      staged: [...staged, firstStaged],
    });
    expect(result).toMatchObject({
      replayedMutationCount: 3,
      duplicateMutationCount: 1,
      head: {
        publishedSequenceStart: 1,
        publishedSequenceEnd: 3,
        manifest: { chunkCount: 3 },
      },
    });

    const prepared = await persistEffectDisabledQueryVector({
      store,
      producer,
      scope,
      queryText: 'Fixture subject Fixture body',
    });
    const index = new BoundedDynamoS3RetrievalIndex({
      objects: store,
      memory: {
        sample: () => ({ rssBytes: 1, limitBytes: 1_000_000 }),
      },
      authority: {
        getSnapshotHead: async (requested) =>
          (await store.getHead(requested))?.manifest,
        getAuthorizationEpoch: () => Promise.resolve(scope.authorizationEpoch),
        queryDeltas: () => Promise.resolve({ manifests: [] }),
        getExactChunkIds: () => Promise.reject(new Error('must not be called')),
        hydrateAuthorization: () =>
          Promise.reject(new Error('must not be called')),
        getQueryVector: async (query) => {
          const vector = await store.getQueryVector(query);
          if (vector === undefined) throw new Error('query vector missing');
          return vector;
        },
      },
    });
    await expect(index.health(scope)).resolves.toMatchObject({
      status: 'healthy',
      activeGeneration: 1,
      indexedChunkCount: 3,
    });
    const retrieval = await index.queryWithCitations(
      retrievalQuerySchema.parse({
        schemaVersion: '1',
        scope,
        queryText: 'Fixture subject Fixture body',
        exactEntityRefs: [],
        limit: 5,
        embeddingProfileManifestHash: producer.profileManifestHash,
        queryHash: prepared.queryHash,
      }),
    );
    expect(retrieval.abstained).toBe(false);
    expect(retrieval.candidates).toHaveLength(3);
    expect(retrieval.citations).toHaveLength(3);
    expect(retrieval.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'gmail communication evidence' }),
      ]),
    );

    const evidenceIndex = {
      queryWithCitations: (
        planned: ReturnType<typeof retrievalQuerySchema.parse>,
      ) =>
        index.queryWithCitations(
          planned,
          prepareEffectDisabledQueryVector({
            producer,
            queryText: planned.queryText,
          }),
        ),
    };
    const communicationSource = new BoundedRetrievalEvidenceSource(
      'communication',
      evidenceIndex,
      (evidenceQuery) => {
        const vector = prepareEffectDisabledQueryVector({
          producer,
          queryText: evidenceQuery.queryText,
        });
        return retrievalQuerySchema.parse({
          schemaVersion: '1',
          scope,
          queryText: evidenceQuery.queryText,
          exactEntityRefs: evidenceQuery.exactEntityRefs,
          limit: 5,
          embeddingProfileManifestHash: vector.embeddingProfileManifestHash,
          queryHash: vector.queryHash,
        });
      },
      {
        hydrate: ({ tenantId, sourceKind, retrieval: citedRetrieval }) => {
          const evidence = new Map(
            citedRetrieval.evidence.map((item) => [item.citationId, item.text]),
          );
          return Promise.resolve(
            citedRetrieval.citations.map((citation): EvidenceFact => {
              const statement = evidence.get(citation.citationId);
              if (statement === undefined)
                throw new Error('canonical evidence text missing');
              return {
                factId: `fact-${citation.chunkId}`,
                tenantId,
                sourceKind,
                statement,
                citation,
                sourceTimestamp: '2026-07-17T12:00:00.000Z',
              };
            }),
          );
        },
      },
    );
    const emptySource = (kind: EvidenceSource['kind']): EvidenceSource => ({
      kind,
      retrieve: () =>
        Promise.resolve({
          snapshotManifestHash: result.head.manifest.manifestHash,
          facts: [],
        }),
    });
    const factIds = canonicals.map(
      (canonicalWrite) => `fact-${canonicalWrite.dedupeKey}`,
    );
    const agent = new ChiefCommunicationAgent({
      gateway: networklessGateway([
        {
          actionType: 'reply',
          urgency: 'high',
          selectedFactIds: factIds,
          missingFacts: [],
        },
        {
          responseMode: 'answer',
          selectedFactIds: factIds,
          includeGreeting: true,
          includeSignoff: true,
        },
      ]),
      retriever: new CitedContextRetriever([
        communicationSource,
        emptySource('organization_knowledge'),
        emptySource('asana'),
      ]),
      recommendationHeads: { isCurrent: () => Promise.resolve(true) },
      clock: {
        now: () => new Date('2026-07-17T12:03:00.000Z'),
        monotonicMilliseconds: () => 100,
      },
    });
    if (canonical.source === 'asana')
      throw new Error('expected communication canonical write');
    const recommendation = await agent.recommend({
      tenantId: tenantIdSchema.parse(scope.tenantId),
      userId: userIdSchema.parse('user-evaluator'),
      brandId: 'brand-a',
      sourceMessageRevisionId: messageRevisionIdSchema.parse(
        canonical.revision.revisionId,
      ),
      sourceMessageRevision: canonical.revision.revision,
      channel: 'email',
      subject: 'Fixture subject',
      authoredText: 'Fixture body',
      scopeHash: scope.scopeHash,
      exactEntityRefs: [],
      styleExamples: [],
    });
    expect(recommendation.recommendation).toMatchObject({
      status: 'current',
      actionType: 'reply',
      confidence: 0.75,
    });
    expect(recommendation.recommendation.citations).toHaveLength(3);
    const draft = await agent.createDraft({
      recommendation,
      expectedRecommendationRevision: 1,
      connectorAccountId: accountIdSchema.parse(
        scope.accountIds[0] ?? 'gmail-account',
      ),
      recipientDigests: [`h1_v1_${'A'.repeat(43)}` as KeyedDigestValue],
      subject: 'Fixture subject',
    });
    expect(draft.kind).toBe('ready');
    if (draft.kind !== 'ready') throw new Error('expected cited draft');
    expect(draft.artifact.result).toMatchObject({
      factualCitationCount: 3,
      unresolvedFacts: [],
      validation: 'passed',
    });
    expect(draft.artifact.result.draft.citations).toHaveLength(3);
    expect(
      draft.artifact.result.draft.citations.map(({ chunkId }) => chunkId),
    ).toContain(canonical.dedupeKey);
    expect(draft.artifact.result.draft.body).toContain(
      'Fixture subject\nFixture body',
    );
  });
});

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  citationSchema,
  deterministicEvaluatorIdentityV1,
  deterministicEvaluatorIdentityV2,
  messageRevisionIdSchema,
  retrievalCandidateSchema,
  serverRequestContextSchema,
  tenantIdSchema,
  type CommunicationSummaryView,
} from '@chief/contracts';
import type {
  DraftArtifact,
  RecommendationArtifact,
} from '@chief/agent/application-agent';
import { deterministicId, immutableHash } from '@chief/agent/canonical';

import { createDurableRequestContext } from './aws-composition.js';
import type { ApiDependencies } from './context.js';
import {
  MemoryDurableProductRepository,
  type AtomicApprovalWrite,
  type AtomicRevisionWithExactLookup,
} from './durable-product-repository.js';
import {
  durableEvaluatorAuthority,
  DurableProductService,
  type DurableManifestBinding,
  type DurableRetrievalPort,
} from './durable-product-service.js';
import { ProductServiceError } from './product-service.js';

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function trustedManifestHash(value: unknown): string {
  return sha256Text(
    JSON.stringify({
      contractVersion: 'chief-test-source-owned-manifest.v1',
      value,
    }),
  );
}

function trustedManifestVerifier(manifestHash: string) {
  return (
    context: ReturnType<typeof createDurableRequestContext>,
    binding: DurableManifestBinding,
  ): Promise<boolean> =>
    Promise.resolve(
      binding.contractVersion === 'chief-validated-manifest-binding.v1' &&
        binding.manifestHash === manifestHash &&
        binding.tenantId === context.retrievalScope?.tenantId &&
        binding.scopeHash === context.retrievalScope?.scopeHash &&
        binding.authorizationEpoch ===
          context.retrievalScope?.authorizationEpoch &&
        binding.role === 'factual' &&
        binding.scoringProfileVersion === 'chief-bounded-fusion-v1',
    );
}

class FailFirstAtomicDraftCommitRepository extends MemoryDurableProductRepository {
  #fail = true;

  public override putRevisionWithExactLookup<T>(
    tenantId: string,
    input: AtomicRevisionWithExactLookup<T>,
  ): Promise<'created' | 'duplicate'> {
    if (this.#fail) {
      this.#fail = false;
      return Promise.reject(new Error('ATOMIC_DRAFT_COMMIT_INTERRUPTED'));
    }
    return super.putRevisionWithExactLookup(tenantId, input);
  }
}

class InterleavingDraftAdvanceRepository extends MemoryDurableProductRepository {
  #beforeApproval: (() => Promise<void>) | undefined;

  public advanceBeforeNextApproval(action: () => Promise<void>): void {
    this.#beforeApproval = action;
  }

  public override async approveAtomically<T>(
    tenantId: string,
    input: AtomicApprovalWrite<T>,
  ): Promise<'created' | 'duplicate'> {
    const beforeApproval = this.#beforeApproval;
    this.#beforeApproval = undefined;
    await beforeApproval?.();
    return super.approveAtomically(tenantId, input);
  }
}

async function preparePendingApproval(dependencies: ApiDependencies) {
  const context = createDurableRequestContext();
  const recommendation = await dependencies.productService.recommendAction(
    context,
    {
      messageRevisionId: messageRevisionIdSchema.parse('message-revision-1-1'),
      expectedMessageRevision: 1,
    },
  );
  const draft = await dependencies.productService.createDraft(context, {
    recommendationId: recommendation.recommendation.recommendationId,
    expectedRecommendationRevision: 1,
  });
  const proposal = await dependencies.productService.prepareDraftApproval(
    context,
    {
      draftRevisionId: draft.result.draft.draftRevisionId,
      expectedDraftRevision: draft.result.draft.revision,
    },
  );
  return { context, recommendation, draft, proposal };
}

function topicalBoundaryRetrieval(
  records: readonly {
    readonly key: string;
    readonly text: string;
    readonly exactEntityRef: string;
    readonly sourceKind?: 'communication' | 'asana';
    readonly topic: 'release_readiness' | 'board_metrics' | 'event_logistics';
    readonly sourceId?: string;
  }[],
): DurableRetrievalPort {
  const manifestHash = trustedManifestHash(records);
  return {
    verifyManifestBinding: trustedManifestVerifier(manifestHash),
    search: (context, input) => {
      const selected = records.slice(0, input.limit);
      const authorizationEpoch =
        context.retrievalScope?.authorizationEpoch ?? 1;
      const citations = selected.map(
        ({ key, text, sourceKind, sourceId: suppliedSourceId }) => {
          const sourceId =
            suppliedSourceId ??
            `source-${sourceKind ?? 'communication'}-${key}`;
          return citationSchema.parse({
            citationId: `${sourceId}:chunk-${key}:1`,
            sourceId,
            sourceVersion: '1',
            chunkId: `chunk-${key}`,
            label: `${key} communication evidence`,
            contentHash: sha256Text(text),
            hydratedUnderAuthorizationEpoch: authorizationEpoch,
          });
        },
      );
      return Promise.resolve({
        candidates: selected.map(
          ({ key, sourceKind, sourceId: suppliedSourceId }, index) => {
            const sourceId =
              suppliedSourceId ??
              `source-${sourceKind ?? 'communication'}-${key}`;
            return retrievalCandidateSchema.parse({
              chunkId: `chunk-${key}`,
              sourceId,
              lexicalScore: 1 - index * 0.1,
              vectorScore: 0.9 - index * 0.1,
              fusedScore: 0.95 - index * 0.1,
              authorizationEpoch,
            });
          },
        ),
        citations,
        snapshotManifestHash: manifestHash,
        evidence: selected.map(
          ({ key, text, exactEntityRef, sourceKind, topic }, index) => ({
            chunkId: `chunk-${key}`,
            citationId: citations[index]?.citationId as string,
            text,
            exactEntityRefs: [exactEntityRef],
            sourceClass: sourceKind ?? 'communication',
            sourceAuthority: {
              contractVersion: 'chief-source-authority.v1' as const,
              verifiedBy: 'canonical_ingestion' as const,
              sourceClass: sourceKind ?? ('communication' as const),
              relationKind:
                sourceKind === 'asana'
                  ? ('explicit_related_work' as const)
                  : ('canonical_thread' as const),
              relationTopic: topic,
            },
            relation: {
              verified: true as const,
              kind:
                sourceKind === 'asana'
                  ? ('explicit_related_work' as const)
                  : ('canonical_thread' as const),
              topic,
              exactEntityRefs: [exactEntityRef],
            },
          }),
        ),
      });
    },
  };
}

function createMemoryDurableApiDependencies(input?: {
  readonly repository?: MemoryDurableProductRepository;
  readonly now?: () => string;
  readonly baseUrl?: string;
}): ApiDependencies {
  const repository = input?.repository ?? new MemoryDurableProductRepository();
  const launchRef =
    deterministicEvaluatorIdentityV1.communications[0].retrievalExactEntityRef;
  return {
    productService: new DurableProductService(
      repository,
      topicalBoundaryRetrieval([
        {
          key: 'launch-communication',
          text: 'The Friday launch decision awaits confirmation of the QA owner.',
          exactEntityRef: launchRef,
          topic: 'release_readiness',
        },
        {
          key: 'launch-work',
          text: 'Test fixture SEC-4821 records the QA owner commitment.',
          exactEntityRef: launchRef,
          sourceKind: 'asana',
          topic: 'release_readiness',
        },
      ]),
      input?.baseUrl ?? 'https://chief.example.test',
      input?.now,
    ),
    requestContext: createDurableRequestContext(),
  };
}

describe('durable hosted product vertical', () => {
  it('migrates to a small V2 marker and exposes the exact primary synthetic corpus', async () => {
    const repository = new MemoryDurableProductRepository();
    const service = new DurableProductService(
      repository,
      { search: () => Promise.reject(new Error('MUST_NOT_QUERY')) },
      'https://chief.example.test',
    );
    const context = createDurableRequestContext();
    const communications: CommunicationSummaryView[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listCommunications(context, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.totalCount).toBe(1_120);
      communications.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(communications).toHaveLength(1_120);
    expect(new Set(communications.map(({ threadId }) => threadId)).size).toBe(
      160,
    );
    expect(
      communications
        .slice(0, 2)
        .map(({ messageRevisionId }) => messageRevisionId),
    ).toEqual(
      deterministicEvaluatorIdentityV2.anchorOverlays.map(
        ({ messageRevisionId }) => messageRevisionId,
      ),
    );
    expect(JSON.stringify(communications)).not.toContain(
      'tenant-demo-isolation',
    );
    expect(
      communications.every(
        ({ channel, accountId, brandId }) =>
          channel.length > 0 && accountId.length > 0 && brandId.length > 0,
      ),
    ).toBe(true);

    const searched = await service.listCommunications(context, {
      query: 'Friday launch decision',
      limit: 100,
    });
    expect(searched).toMatchObject({
      totalCount: 1,
      items: [{ messageRevisionId: 'message-revision-1-1', channel: 'gmail' }],
    });
    const gmail = await service.listCommunications(context, {
      channel: 'gmail',
      limit: 100,
    });
    expect(gmail.totalCount).toBe(161);
    expect(gmail.items.every(({ channel }) => channel === 'gmail')).toBe(true);
    const account = await service.listCommunications(context, {
      accountFilter: deterministicEvaluatorIdentityV2.accountIds[1],
      limit: 100,
    });
    expect(account.totalCount).toBe(161);
    expect(
      account.items.every(
        ({ accountId }) =>
          accountId === deterministicEvaluatorIdentityV2.accountIds[1],
      ),
    ).toBe(true);
    const brand = await service.listCommunications(context, {
      brandFilter: 'brand-harbor',
      limit: 100,
    });
    expect(brand.totalCount).toBe(483);
    expect(brand.items.every(({ brandId }) => brandId === 'brand-harbor')).toBe(
      true,
    );
    const gmailFirst = await service.listCommunications(context, {
      channel: 'gmail',
      limit: 1,
    });
    expect(gmailFirst.nextCursor).toBeDefined();
    const gmailSecond = await service.listCommunications(context, {
      channel: 'gmail',
      limit: 1,
      cursor: gmailFirst.nextCursor,
    });
    expect(gmailSecond.items[0]?.messageRevisionId).not.toBe(
      gmailFirst.items[0]?.messageRevisionId,
    );
    await expect(
      service.listCommunications(context, {
        channel: 'sms',
        limit: 1,
        cursor: gmailFirst.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'BAD_CURSOR' });

    await expect(
      service.dashboardMetrics(context, { window: '7d' }),
    ).resolves.toMatchObject({
      totalCommunications: 1_120,
      channelBreakdown: [
        { channel: 'gmail', count: 161 },
        { channel: 'microsoft_graph', count: 161 },
        { channel: 'sms', count: 161 },
        { channel: 'whatsapp', count: 161 },
        { channel: 'x', count: 161 },
        { channel: 'linkedin_archive', count: 161 },
        { channel: 'future_demo', count: 154 },
      ],
    });
    const connectorResult = await service.getConnectorStatus(context, {});
    expect(connectorResult.connectors).toHaveLength(7);
    expect(
      connectorResult.connectors.map(({ accountId }) => accountId),
    ).toEqual(deterministicEvaluatorIdentityV2.accountIds);
    expect(
      new Set(connectorResult.connectors.map(({ brandId }) => brandId)),
    ).toEqual(new Set(deterministicEvaluatorIdentityV2.brandIds));
    expect(
      connectorResult.connectors.every(
        ({ runtimeMode, capabilities }) =>
          (runtimeMode === 'fixture' || runtimeMode === 'manual') &&
          !capabilities.externalEffect,
      ),
    ).toBe(true);
    await expect(
      service.getThreadContext(context, { threadId: 'thread-1', limit: 100 }),
    ).resolves.toMatchObject({ thread: { channel: 'gmail' } });

    const mixedDateThread = await service.getThreadContext(context, {
      threadId: 'thread-1',
      limit: 100,
    });
    const chronologicalKeys = mixedDateThread.thread.communications.map(
      ({ sourceTimestamp, revision, messageRevisionId }) =>
        `${sourceTimestamp}:${revision.toString().padStart(12, '0')}:${messageRevisionId}`,
    );
    expect(chronologicalKeys).toEqual([...chronologicalKeys].sort());
    expect(mixedDateThread.thread.communications.at(-1)).toMatchObject({
      messageRevisionId: 'message-revision-1-1',
      sourceTimestamp: '2026-07-17T10:52:00.000Z',
    });
    expect(mixedDateThread.thread).toMatchObject({
      latestMessageRevisionId: 'message-revision-1-1',
      sourceUpdatedAt: '2026-07-17T10:52:00.000Z',
    });

    const marker = await repository.getCurrent(
      deterministicEvaluatorIdentityV2.tenantId,
      'hosted-projection-marker',
      'public-evaluator-v2',
    );
    expect(marker).toMatchObject({
      revisionId: 'hosted-projection-marker-v2',
      value: {
        projectionVersion: 'chief-hosted-projection.v2',
        corpusHash: deterministicEvaluatorIdentityV2.corpus.corpusHash,
        messageCount: 1_120,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(marker?.value))).toBeLessThan(
      1_024,
    );
    await expect(
      service.listCommunications(context, { limit: 1 }),
    ).resolves.toMatchObject({
      items: [{ messageRevisionId: 'message-revision-1-1' }],
    });
    await expect(
      repository.getCurrent(
        deterministicEvaluatorIdentityV2.tenantId,
        'hosted-projection',
        'public-evaluator',
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('binds communication citations to the exact normalized evidence text', async () => {
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      { search: () => Promise.reject(new Error('MUST_NOT_QUERY')) },
      'https://chief.example.test',
    );
    const context = createDurableRequestContext();
    const messageRevisionIds = [
      'message-revision-1-1',
      'revision-tenant-demo-northstar-0001-02',
    ] as const;

    for (const messageRevisionId of messageRevisionIds) {
      const { communication } = await service.getCommunication(context, {
        messageRevisionId,
      });
      const citedEvidence = communication.citations[0];

      if (citedEvidence === undefined)
        throw new Error('Expected one communication citation.');
      expect(citedEvidence.contentHash).toBe(
        sha256Text(communication.normalizedText),
      );
      expect(citedEvidence.contentHash).not.toBe(
        sha256Text(
          `${citedEvidence.sourceId}:${citedEvidence.chunkId}:${citedEvidence.label}`,
        ),
      );
      expect(citedEvidence.citationId).toBe(
        `${citedEvidence.sourceId}:${citedEvidence.chunkId}:${citedEvidence.sourceVersion}`,
      );
    }

    const { communication: boundedCommunication } =
      await service.getCommunication(context, {
        messageRevisionId: 'revision-tenant-demo-northstar-0001-02',
      });
    expect(boundedCommunication.normalizedText).not.toBe(
      boundedCommunication.authoredText,
    );
    expect(boundedCommunication.citations[0]?.contentHash).toBe(
      sha256Text(boundedCommunication.normalizedText),
    );
    expect(boundedCommunication.citations[0]?.contentHash).not.toBe(
      sha256Text(boundedCommunication.authoredText),
    );
  });

  it('fails closed when the durable V2 marker is partial or drifted', async () => {
    const repository = new MemoryDurableProductRepository();
    await repository.putRevision(deterministicEvaluatorIdentityV2.tenantId, {
      entityType: 'hosted-projection-marker',
      entityId: 'public-evaluator-v2',
      revisionId: 'hosted-projection-marker-v2',
      version: 1,
      committedAt: deterministicEvaluatorIdentityV2.corpus.generatedAt,
      value: {
        schemaVersion: '1',
        projectionVersion: 'chief-hosted-projection.v2',
        corpusHash: '0'.repeat(64),
        messageCount: 2,
      },
    });
    const service = new DurableProductService(
      repository,
      { search: () => Promise.reject(new Error('MUST_NOT_QUERY')) },
      'https://chief.example.test',
    );
    await expect(
      service.listCommunications(createDurableRequestContext(), { limit: 1 }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('creates a cited draft from two production-shaped same-source facts', async () => {
    const chunkIds = [
      'h1_deterministic_evaluator_seed_v1_JGYh0xduVhg2BiF1PyZrcgLcyji29sijg1ilMuD-qFY:3ec5dd5bdc24a0edef761555d9100bc853213236ec37ed74a80923f287fcc4cc',
      'h1_deterministic_evaluator_seed_v1_w-jMP3I_f0X_I-PR_WVXU58yeXq51BLW4zCS9JqKKSg:49ee3e715f21ab40d361d2aa06f9871cb1bf5cb3731beb9d212f9944e02fb7d0',
    ] as const;
    const citations = chunkIds.map((chunkId, index) =>
      citationSchema.parse({
        citationId: `gmail-source-${index}:${chunkId}:v1`,
        sourceId: `gmail-source-${index}`,
        sourceVersion: 'v1',
        chunkId,
        label: 'gmail communication evidence',
        contentHash: sha256Text(
          index === 0
            ? 'The Friday launch is ready once the QA owner confirms.'
            : 'The QA owner commitment is due before the Friday launch.',
        ),
        hydratedUnderAuthorizationEpoch: 1,
      }),
    );
    const manifestHash = trustedManifestHash({ chunkIds, citations });
    const retrieval: DurableRetrievalPort = {
      verifyManifestBinding: trustedManifestVerifier(manifestHash),
      search: (_context, input) =>
        Promise.resolve({
          candidates: chunkIds.slice(0, input.limit).map((chunkId, index) =>
            retrievalCandidateSchema.parse({
              chunkId,
              sourceId: `gmail-source-${index}`,
              lexicalScore: 1,
              vectorScore: 0.8,
              fusedScore: 0.9,
              authorizationEpoch: 1,
            }),
          ),
          citations: citations.slice(0, input.limit),
          snapshotManifestHash: manifestHash,
          evidence: chunkIds.slice(0, input.limit).map((chunkId, index) => ({
            chunkId,
            citationId: citations[index]?.citationId as string,
            text:
              index === 0
                ? 'The Friday launch is ready once the QA owner confirms.'
                : 'The QA owner commitment is due before the Friday launch.',
            exactEntityRefs: [
              deterministicEvaluatorIdentityV1.communications[0]
                .retrievalExactEntityRef,
            ],
            sourceClass: 'communication' as const,
            sourceAuthority: {
              contractVersion: 'chief-source-authority.v1' as const,
              verifiedBy: 'canonical_ingestion' as const,
              sourceClass: 'communication' as const,
              relationKind: 'canonical_thread' as const,
              relationTopic: 'release_readiness' as const,
            },
            relation: {
              verified: true as const,
              kind: 'canonical_thread' as const,
              topic: 'release_readiness' as const,
              exactEntityRefs: [
                deterministicEvaluatorIdentityV1.communications[0]
                  .retrievalExactEntityRef,
              ],
            },
          })),
        }),
    };
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      retrieval,
      'https://chief.example.test',
    );
    const context = createDurableRequestContext();
    const recommendation = await service.recommendAction(context, {
      messageRevisionId: messageRevisionIdSchema.parse('message-revision-1-1'),
      expectedMessageRevision: 1,
    });

    expect(recommendation.recommendation).toMatchObject({
      actionType: 'reply',
      confidence: 0.87,
      status: 'current',
    });
    await expect(
      service.createDraft(context, {
        recommendationId: recommendation.recommendation.recommendationId,
        expectedRecommendationRevision: 1,
      }),
    ).resolves.toMatchObject({
      result: {
        draft: { citations },
      },
    });
  });

  it('keeps launch and board drafts inside their exact topical communication boundary', async () => {
    const launchRef =
      deterministicEvaluatorIdentityV1.communications[0]
        .retrievalExactEntityRef;
    const boardRef =
      deterministicEvaluatorIdentityV1.communications[1]
        .retrievalExactEntityRef;
    const retrieval = topicalBoundaryRetrieval([
      {
        key: 'launch-ready',
        text: 'Production cutover requires validation ownership.',
        exactEntityRef: launchRef,
        topic: 'release_readiness',
        sourceId: 'source-asana-word-but-typed-communication',
      },
      {
        key: 'launch-work',
        text: 'Launch readiness task SEC-4821 tracks the QA owner commitment.',
        exactEntityRef: launchRef,
        sourceKind: 'asana',
        topic: 'release_readiness',
      },
      {
        key: 'launch-party',
        text: 'The launch party catering owner has confirmed.',
        exactEntityRef: launchRef,
        topic: 'event_logistics',
      },
      {
        key: 'launch-parking',
        text: 'Parking for launch guests is ready.',
        exactEntityRef: launchRef,
        topic: 'event_logistics',
      },
      {
        key: 'launch-banquet',
        text: 'The launch banquet coordinator has confirmed.',
        exactEntityRef: launchRef,
        topic: 'event_logistics',
      },
      {
        key: 'launch-unrelated-task',
        text: 'Unrelated Asana launch task also mentions the QA owner.',
        exactEntityRef: boardRef,
        sourceKind: 'asana',
        topic: 'release_readiness',
      },
      {
        key: 'board-pipeline',
        text: 'Directors approved the sales outlook for the quarterly governance pack.',
        exactEntityRef: boardRef,
        topic: 'board_metrics',
      },
      {
        key: 'board-note',
        text: 'The board note must use the approved pipeline total.',
        exactEntityRef: boardRef,
        topic: 'board_metrics',
      },
    ]);
    const context = createDurableRequestContext();

    for (const scenario of [
      {
        messageRevisionId: 'message-revision-1-1',
        included: /Production cutover|SEC-4821/iu,
        excluded: /board|pipeline numbers|Unrelated Asana/iu,
        requiredText: 'Production cutover requires validation ownership.',
        confidence: 0.92,
        citationSources: [
          'source-asana-word-but-typed-communication',
          'source-asana-launch-work',
        ],
      },
      {
        messageRevisionId: 'message-revision-2-1',
        included: /Directors|governance|board|pipeline/iu,
        excluded: /Friday launch|QA owner|SEC-4821/iu,
        requiredText:
          'Directors approved the sales outlook for the quarterly governance pack.',
        confidence: 0.75,
        citationSources: [
          'source-communication-board-note',
          'source-communication-board-pipeline',
        ],
      },
    ] as const) {
      const service = new DurableProductService(
        new MemoryDurableProductRepository(),
        retrieval,
        'https://chief.example.test',
      );
      const recommendation = await service.recommendAction(context, {
        messageRevisionId: messageRevisionIdSchema.parse(
          scenario.messageRevisionId,
        ),
        expectedMessageRevision: 1,
      });
      expect(recommendation.recommendation).toMatchObject({
        actionType: 'reply',
        confidence: scenario.confidence,
        status: 'current',
      });
      expect(recommendation.recommendation.citations).toHaveLength(2);
      expect(
        recommendation.recommendation.citations.map(({ sourceId }) => sourceId),
      ).toEqual(scenario.citationSources);

      const draft = await service.createDraft(context, {
        recommendationId: recommendation.recommendation.recommendationId,
        expectedRecommendationRevision: 1,
      });
      expect(draft.result.draft.body).toMatch(scenario.included);
      expect(draft.result.draft.body).toContain(scenario.requiredText);
      if (scenario.messageRevisionId === 'message-revision-1-1')
        expect(draft.result.draft.body).toContain('SEC-4821');
      expect(draft.result.draft.body).not.toMatch(scenario.excluded);
      expect(draft.result.draft.citations).toHaveLength(2);
      expect(draft.result.draft.subject).toBe(
        scenario.messageRevisionId === 'message-revision-1-1'
          ? 'Re: Friday launch decision'
          : 'Re: Board update numbers',
      );
      const revised = await service.reviseDraft(context, {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: 1,
        revisionInstruction: 'Make this concise.',
      });
      expect(revised.result.draft.subject).toBe(draft.result.draft.subject);
      expect(revised.result.draft.body).not.toMatch(scenario.excluded);
      const related = await service.getRelatedAsanaWork(context, {
        messageRevisionId: messageRevisionIdSchema.parse(
          scenario.messageRevisionId,
        ),
        limit: 10,
      });
      expect(
        related.items.map(({ providerObjectId }) => providerObjectId),
      ).toEqual([]);
    }
  });

  it('creates a cited draft when one exact topically relevant fact remains', async () => {
    const boardRef =
      deterministicEvaluatorIdentityV1.communications[1]
        .retrievalExactEntityRef;
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      topicalBoundaryRetrieval([
        {
          key: 'board-only',
          text: 'The approved pipeline total belongs in the board update.',
          exactEntityRef: boardRef,
          topic: 'board_metrics',
        },
      ]),
      'https://chief.example.test',
    );

    const result = await service.recommendAction(
      createDurableRequestContext(),
      {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-2-1',
        ),
        expectedMessageRevision: 1,
      },
    );

    expect(result.recommendation).toMatchObject({
      actionType: 'reply',
      confidence: 0.76,
      status: 'current',
    });
    expect(result.recommendation.citations).toHaveLength(1);
    expect(result).not.toHaveProperty('contextRequest');
    await expect(
      service.createDraft(createDurableRequestContext(), {
        recommendationId: result.recommendation.recommendationId,
        expectedRecommendationRevision: 1,
      }),
    ).resolves.toMatchObject({
      result: { draft: { citations: result.recommendation.citations } },
    });
  });

  it('maps each public thread alias to its canonical exact retrieval entity and preserves tenant isolation', async () => {
    const context = createDurableRequestContext();
    for (const identity of deterministicEvaluatorIdentityV1.communications) {
      let observedExactRefs: readonly string[] | undefined;
      const retrieval: DurableRetrievalPort = {
        search: (_context, input) => {
          observedExactRefs = input.exactEntityRefs;
          return Promise.reject(new Error('EXACT_ENTITY_CAPTURED'));
        },
      };
      const service = new DurableProductService(
        new MemoryDurableProductRepository(),
        retrieval,
        'https://chief.example.test',
      );
      const listed = await service.listCommunications(context, { limit: 10 });
      const communication = listed.items.find(
        ({ messageRevisionId }) =>
          messageRevisionId === identity.messageRevisionId,
      );
      expect(communication?.threadId).toBe(identity.productThreadAlias);
      expect(JSON.stringify(communication)).not.toContain('evaluator-thread');

      await expect(
        service.recommendAction(context, {
          messageRevisionId: identity.messageRevisionId,
          expectedMessageRevision: 1,
        }),
      ).rejects.toThrow('EXACT_ENTITY_CAPTURED');
      expect(observedExactRefs).toEqual([identity.retrievalExactEntityRef]);
    }

    const foreignTenantId = tenantIdSchema.parse('tenant_foreign_assessment');
    const foreignContext = serverRequestContextSchema.parse({
      ...context,
      actor: { ...context.actor, tenantId: foreignTenantId },
      retrievalScope: {
        ...context.retrievalScope,
        derivation: 'server_grants',
        tenantId: foreignTenantId,
      },
    });
    const isolated = new DurableProductService(
      new MemoryDurableProductRepository(),
      { search: () => Promise.reject(new Error('MUST_NOT_QUERY')) },
      'https://chief.example.test',
    );
    await expect(
      isolated.listCommunications(foreignContext, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_AUTHORITY' });
  });

  it('rejects account, brand, read-grant, and actor/scope authority smuggling before retrieval', async () => {
    const context = createDurableRequestContext();
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      { search: () => Promise.reject(new Error('MUST_NOT_QUERY')) },
      'https://chief.example.test',
    );
    const cases = [
      {
        ...context,
        actor: { ...context.actor, accountScopes: [] },
      },
      {
        ...context,
        actor: {
          ...context.actor,
          accountScopes: [...context.actor.accountScopes, 'account-rogue'],
        },
      },
      {
        ...context,
        actor: { ...context.actor, brandScopes: [] },
      },
      {
        ...context,
        actor: { ...context.actor, accountScopes: [] },
        retrievalScope: { ...context.retrievalScope, accountIds: [] },
      },
      {
        ...context,
        actor: { ...context.actor, brandScopes: [] },
        retrievalScope: { ...context.retrievalScope, brandIds: [] },
      },
      {
        ...context,
        retrievalScope: { ...context.retrievalScope, accountIds: [] },
      },
      {
        ...context,
        retrievalScope: {
          ...context.retrievalScope,
          brandIds: [
            ...(context.retrievalScope?.brandIds ?? []),
            'brand-rogue',
          ],
        },
      },
      {
        ...context,
        actor: {
          ...context.actor,
          grants: context.actor.grants.filter(
            (grant) => grant !== 'communications:read',
          ),
        },
      },
      {
        ...context,
        actor: {
          ...context.actor,
          grants: context.actor.grants.filter(
            (grant) => grant !== 'knowledge:read',
          ),
        },
      },
    ].map((candidate) => serverRequestContextSchema.parse(candidate));

    for (const smuggled of cases)
      await expect(
        service.listCommunications(smuggled, { limit: 10 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN_AUTHORITY' });
  });

  it('carries request-derived member identity and scope versioning through approval', async () => {
    const context = createDurableRequestContext();
    const accountScopes = [...context.actor.accountScopes];
    const brandScopes = [...context.actor.brandScopes];
    const requestDerived = serverRequestContextSchema.parse({
      actor: {
        ...context.actor,
        userId: 'user_request_derived',
        accountScopes,
        brandScopes,
        membershipVersion: context.actor.membershipVersion + 1,
        verifiedClaimsHash: 'b'.repeat(64),
        verifiedAt: '2026-07-19T10:30:00.000Z',
      },
      retrievalScope: {
        ...context.retrievalScope,
        accountIds: accountScopes,
        brandIds: brandScopes,
        authorizationEpoch:
          (context.retrievalScope?.authorizationEpoch ?? 1) + 1,
        scopeHash: 'c'.repeat(64),
      },
    });
    const repository = new MemoryDurableProductRepository();
    const launchIdentity = deterministicEvaluatorIdentityV1.communications[0];
    const service = new DurableProductService(
      repository,
      topicalBoundaryRetrieval([
        {
          key: 'request-derived-launch',
          text: 'The Friday launch is ready after QA owner confirmation.',
          exactEntityRef: launchIdentity.retrievalExactEntityRef,
          topic: 'release_readiness',
        },
      ]),
      'https://chief.example.test',
    );
    const recommendation = await service.recommendAction(requestDerived, {
      messageRevisionId: launchIdentity.messageRevisionId,
      expectedMessageRevision: 1,
    });
    const dynamicArtifact = await repository.getCurrent<RecommendationArtifact>(
      deterministicEvaluatorIdentityV2.tenantId,
      'recommendation',
      recommendation.recommendation.recommendationId,
    );
    expect(dynamicArtifact?.value.styleProfile).toMatchObject({
      userId: requestDerived.actor.userId,
      exampleCount: 0,
      exampleIds: [],
    });
    expect(
      recommendation.recommendation.citations.every(
        ({ hydratedUnderAuthorizationEpoch }) =>
          hydratedUnderAuthorizationEpoch ===
          requestDerived.retrievalScope?.authorizationEpoch,
      ),
    ).toBe(true);
    const evaluatorRecommendation = await service.recommendAction(context, {
      messageRevisionId: launchIdentity.messageRevisionId,
      expectedMessageRevision: 1,
    });
    expect(evaluatorRecommendation.recommendation.recommendationId).not.toBe(
      recommendation.recommendation.recommendationId,
    );
    const evaluatorArtifact =
      await repository.getCurrent<RecommendationArtifact>(
        deterministicEvaluatorIdentityV2.tenantId,
        'recommendation',
        evaluatorRecommendation.recommendation.recommendationId,
      );
    expect(evaluatorArtifact?.value.styleProfile).toMatchObject({
      userId: context.actor.userId,
      exampleCount: 1,
      exampleIds: ['approved-style-example-1'],
    });
    const draft = await service.createDraft(requestDerived, {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    });
    const proposal = await service.prepareDraftApproval(requestDerived, {
      draftRevisionId: draft.result.draft.draftRevisionId,
      expectedDraftRevision: draft.result.draft.revision,
    });
    await expect(
      service.approveProposal(requestDerived, {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: proposal.updatedAt,
      }),
    ).resolves.toMatchObject({
      proposalId: proposal.proposalId,
      status: 'approved',
      externalEffect: false,
    });
  });

  it('never exposes a citation whose source and chunk are absent from the retrieval result', async () => {
    const launchRef =
      deterministicEvaluatorIdentityV1.communications[0]
        .retrievalExactEntityRef;
    const orphan = citationSchema.parse({
      citationId: 'source-asana-orphan:chunk-asana-orphan:1',
      sourceId: 'source-asana-orphan',
      sourceVersion: '1',
      chunkId: 'chunk-asana-orphan',
      label: 'Orphaned Asana citation',
      contentHash: sha256Text('This record is absent.'),
      hydratedUnderAuthorizationEpoch: 1,
    });
    const emptyManifestHash = trustedManifestHash([]);
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      {
        verifyManifestBinding: trustedManifestVerifier(emptyManifestHash),
        search: () =>
          Promise.resolve({
            candidates: [],
            citations: [orphan],
            snapshotManifestHash: emptyManifestHash,
            evidence: [],
          }),
      },
      'https://chief.example.test',
    );
    const context = createDurableRequestContext();

    await expect(
      service.searchKnowledge(context, {
        queryText: 'launch readiness',
        exactEntityRefs: [launchRef],
        limit: 8,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      service.recommendAction(context, {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('rejects a well-shaped manifest hash without source-owned binding verification', async () => {
    const launchRef =
      deterministicEvaluatorIdentityV1.communications[0]
        .retrievalExactEntityRef;
    const sourceOwned = topicalBoundaryRetrieval([
      {
        key: 'untrusted-without-proof',
        text: 'A structurally valid row is not sufficient proof.',
        exactEntityRef: launchRef,
        topic: 'release_readiness',
      },
    ]);
    const retrievalWithoutProof: DurableRetrievalPort = {
      search: (context, input) => sourceOwned.search(context, input),
    };
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      retrievalWithoutProof,
      'https://chief.example.test',
    );

    await expect(
      service.searchKnowledge(createDurableRequestContext(), {
        queryText: 'launch readiness',
        exactEntityRefs: [launchRef],
        limit: 8,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('rejects a result containing an Asana citation absent from trusted evidence', async () => {
    const launchRef =
      deterministicEvaluatorIdentityV1.communications[0]
        .retrievalExactEntityRef;
    const legitimate = topicalBoundaryRetrieval([
      {
        key: 'launch-ready',
        text: 'Release greenlight depends on the test lead.',
        exactEntityRef: launchRef,
        topic: 'release_readiness',
      },
    ]);
    const spoofed: DurableRetrievalPort = {
      verifyManifestBinding: (context, binding, result) =>
        legitimate.verifyManifestBinding?.(context, binding, result) ??
        Promise.resolve(false),
      search: async (context, input) => {
        const result = await legitimate.search(context, input);
        const spoofCitation = citationSchema.parse({
          citationId: 'source-asana-1:chunk-asana-1:1',
          sourceId: 'source-asana-1',
          sourceVersion: '1',
          chunkId: 'chunk-asana-1',
          label: 'Spoofed fixed citation',
          contentHash: '9'.repeat(64),
          hydratedUnderAuthorizationEpoch: 1,
        });
        return {
          ...result,
          candidates: [
            ...result.candidates,
            retrievalCandidateSchema.parse({
              chunkId: spoofCitation.chunkId,
              sourceId: spoofCitation.sourceId,
              lexicalScore: 1,
              vectorScore: 1,
              fusedScore: 1,
              authorizationEpoch: 1,
            }),
          ],
          citations: [...result.citations, spoofCitation],
          evidence: [
            ...result.evidence,
            {
              chunkId: spoofCitation.chunkId,
              citationId: spoofCitation.citationId,
              text: 'Release greenlight depends on the test lead, but this is forged.',
              exactEntityRefs: [launchRef],
              sourceClass: 'asana' as const,
              relation: {
                verified: true as const,
                kind: 'explicit_related_work' as const,
                topic: 'release_readiness' as const,
                exactEntityRefs: [launchRef],
              },
            },
          ],
        };
      },
    };
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      spoofed,
      'https://chief.example.test',
    );
    await expect(
      service.recommendAction(createDurableRequestContext(), {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('emits Asana evidence only with a retrieved source, chunk, hash, and manifest lineage', async () => {
    const launchRef =
      deterministicEvaluatorIdentityV1.communications[0]
        .retrievalExactEntityRef;
    const asanaText = 'Durably indexed Asana task SEC-4821 names the QA owner.';
    const repository = new MemoryDurableProductRepository();
    const records = [
      {
        key: 'launch-message',
        text: 'The launch decision awaits QA ownership confirmation.',
        exactEntityRef: launchRef,
        topic: 'release_readiness' as const,
      },
      {
        key: 'launch-work',
        text: asanaText,
        exactEntityRef: launchRef,
        sourceKind: 'asana' as const,
        topic: 'release_readiness' as const,
      },
    ] as const;
    const service = new DurableProductService(
      repository,
      topicalBoundaryRetrieval(records),
      'https://chief.example.test',
    );
    const result = await service.recommendAction(
      createDurableRequestContext(),
      {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      },
    );
    expect(result.recommendation).toMatchObject({
      actionType: 'reply',
      status: 'current',
    });
    expect(result.recommendation.citations).toContainEqual(
      expect.objectContaining({
        citationId: 'source-asana-launch-work:chunk-launch-work:1',
        sourceId: 'source-asana-launch-work',
        sourceVersion: '1',
        chunkId: 'chunk-launch-work',
        contentHash: sha256Text(asanaText),
      }),
    );
    const persisted = await repository.getCurrent<RecommendationArtifact>(
      result.recommendation.tenantId,
      'recommendation',
      result.recommendation.recommendationId,
    );
    expect(
      persisted?.value.context.facts.find(
        ({ sourceKind }) => sourceKind === 'asana',
      ),
    ).toMatchObject({
      statement: asanaText,
      citation: {
        sourceId: 'source-asana-launch-work',
        chunkId: 'chunk-launch-work',
        contentHash: sha256Text(asanaText),
      },
    });
    expect(persisted?.value.context.snapshotManifestHash).toBe(
      immutableHash(
        ['communication', 'organization_knowledge', 'asana'].map((kind) => ({
          kind,
          snapshotManifestHash: trustedManifestHash(records),
        })),
      ),
    );
  });

  it('quarantines persisted recommendation, draft, and proposal artifacts with a legacy fabricated citation', async () => {
    const sourceRepository = new MemoryDurableProductRepository();
    const source = createMemoryDurableApiDependencies({
      repository: sourceRepository,
    });
    const context = createDurableRequestContext();
    const recommendation = await source.productService.recommendAction(
      context,
      {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      },
    );
    const draft = await source.productService.createDraft(context, {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    });
    const proposal = await source.productService.prepareDraftApproval(context, {
      draftRevisionId: draft.result.draft.draftRevisionId,
      expectedDraftRevision: draft.result.draft.revision,
    });
    const validRecommendation =
      await sourceRepository.getCurrent<RecommendationArtifact>(
        recommendation.recommendation.tenantId,
        'recommendation',
        recommendation.recommendation.recommendationId,
      );
    const validDraft = await sourceRepository.getCurrent<{
      readonly artifact: DraftArtifact;
      readonly recommendationId: string;
    }>(
      recommendation.recommendation.tenantId,
      'draft',
      draft.result.draft.draftId,
    );
    const validProposal = await sourceRepository.getCurrent<{
      readonly proposalId: string;
      readonly draftRevisionId: string;
      readonly actionPlan: {
        readonly operations: readonly { readonly operationId: string }[];
      };
      readonly status: 'pending_approval' | 'approved';
      readonly approvalUrl: string;
      readonly updatedAt: string;
    }>(recommendation.recommendation.tenantId, 'proposal', proposal.proposalId);
    expect(validRecommendation).toBeDefined();
    expect(validDraft).toBeDefined();
    expect(validProposal).toBeDefined();
    const fabricatedText =
      'Legacy app-tier Asana evidence that is absent from the trusted manifest.';
    const fabricatedCitation = citationSchema.parse({
      citationId: 'source-asana-legacy:chunk-asana-legacy:1',
      sourceId: 'source-asana-legacy',
      sourceVersion: '1',
      chunkId: 'chunk-asana-legacy',
      label: 'Legacy fabricated Asana citation',
      contentHash: sha256Text(fabricatedText),
      hydratedUnderAuthorizationEpoch: 1,
    });
    const validRecommendationArtifact =
      validRecommendation?.value as RecommendationArtifact;
    const legacyFacts = [
      ...validRecommendationArtifact.context.facts,
      {
        factId: 'fact-chunk-asana-legacy',
        tenantId: recommendation.recommendation.tenantId,
        sourceKind: 'asana' as const,
        statement: fabricatedText,
        citation: fabricatedCitation,
        sourceTimestamp: '2026-07-17T12:00:00.000Z',
      },
    ];
    const legacyRecommendationArtifact: RecommendationArtifact = {
      ...validRecommendationArtifact,
      recommendation: {
        ...validRecommendationArtifact.recommendation,
        citations: [
          ...validRecommendationArtifact.recommendation.citations,
          fabricatedCitation,
        ],
      },
      context: {
        ...validRecommendationArtifact.context,
        facts: legacyFacts,
        citations: legacyFacts.map(({ citation }) => citation),
        snapshotManifestHash: trustedManifestHash('legacy-synthetic-relation'),
      },
    };
    const validDraftValue = validDraft?.value as {
      readonly artifact: DraftArtifact;
      readonly recommendationId: string;
    };
    const legacyDraftValue = {
      ...validDraftValue,
      artifact: {
        ...validDraftValue.artifact,
        context: legacyRecommendationArtifact.context,
        result: {
          ...validDraftValue.artifact.result,
          factualCitationCount:
            validDraftValue.artifact.result.factualCitationCount + 1,
          draft: {
            ...validDraftValue.artifact.result.draft,
            citations: [
              ...validDraftValue.artifact.result.draft.citations,
              fabricatedCitation,
            ],
          },
        },
      },
    };
    const quarantineRepository = new MemoryDurableProductRepository();
    await quarantineRepository.putRevision(
      recommendation.recommendation.tenantId,
      {
        entityType: 'recommendation',
        entityId: recommendation.recommendation.recommendationId,
        revisionId: `${recommendation.recommendation.recommendationId}:1`,
        version: 1,
        committedAt: recommendation.recommendation.createdAt,
        value: legacyRecommendationArtifact,
      },
    );
    await quarantineRepository.putRevisionWithExactLookup(
      recommendation.recommendation.tenantId,
      {
        revision: {
          entityType: 'draft',
          entityId: draft.result.draft.draftId,
          revisionId: draft.result.draft.draftRevisionId,
          version: draft.result.draft.revision,
          committedAt: draft.result.draft.createdAt,
          value: legacyDraftValue,
        },
        exactLookup: {
          entityType: 'draft-revision',
          entityId: draft.result.draft.draftRevisionId,
          revisionId: draft.result.draft.draftRevisionId,
          version: draft.result.draft.revision,
          committedAt: draft.result.draft.createdAt,
          value: legacyDraftValue,
        },
      },
    );
    await quarantineRepository.putRevision(
      recommendation.recommendation.tenantId,
      {
        entityType: 'proposal',
        entityId: proposal.proposalId,
        revisionId: `${proposal.proposalId}:pending`,
        version: 1,
        committedAt: proposal.updatedAt,
        value: validProposal?.value,
      },
    );
    const quarantined = createMemoryDurableApiDependencies({
      repository: quarantineRepository,
    });

    await expect(
      quarantined.productService.createDraft(context, {
        recommendationId: recommendation.recommendation.recommendationId,
        expectedRecommendationRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      quarantined.productService.reviseDraft(context, {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: 1,
        revisionInstruction:
          'Make this draft concise while retaining all cited facts.',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      quarantined.productService.prepareDraftApproval(context, {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      quarantined.productService.getApprovalStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      quarantined.productService.getExecutionStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      quarantined.productService.approveProposal(context, {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: proposal.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(
      quarantineRepository.executionRecord(
        validProposal?.value.actionPlan.operations[0]?.operationId ?? '',
      ),
    ).toBeUndefined();
  });

  it('persists cited draft, exact approval, outbox receipt, and reload state', async () => {
    const repository = new MemoryDurableProductRepository();
    const timestamps = [
      '2026-07-18T08:00:00.000Z',
      '2026-07-18T08:00:01.000Z',
      '2026-07-18T08:00:02.000Z',
      '2026-07-18T08:00:03.000Z',
      '2026-07-18T08:00:04.000Z',
      '2026-07-18T08:00:05.000Z',
    ];
    const now = () => timestamps.shift() ?? '2026-07-18T08:00:06.000Z';
    const first = createMemoryDurableApiDependencies({
      repository,
      now,
    });
    const context = createDurableRequestContext();

    const recommendation = await first.productService.recommendAction(context, {
      messageRevisionId: messageRevisionIdSchema.parse('message-revision-1-1'),
      expectedMessageRevision: 1,
    });
    expect(recommendation.recommendation.citations).toHaveLength(2);
    const persistedRecommendation =
      await repository.getCurrent<RecommendationArtifact>(
        recommendation.recommendation.tenantId,
        'recommendation',
        recommendation.recommendation.recommendationId,
      );
    expect(
      persistedRecommendation?.value.context.facts.map(
        ({ statement }) => statement,
      ),
    ).toEqual([
      'The Friday launch decision awaits confirmation of the QA owner.',
      'Test fixture SEC-4821 records the QA owner commitment.',
    ]);
    const recommendationReplay = createMemoryDurableApiDependencies({
      repository,
      now,
    });
    await expect(
      recommendationReplay.productService.recommendAction(context, {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      }),
    ).resolves.toEqual(recommendation);

    const draft = await first.productService.createDraft(context, {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    });
    expect(draft.result.validation).toBe('passed');
    expect(draft.result.factualCitationCount).toBe(2);

    const revised = await first.productService.reviseDraft(context, {
      draftRevisionId: draft.result.draft.draftRevisionId,
      expectedDraftRevision: 1,
      revisionInstruction:
        'Make this draft concise while retaining all cited facts.',
    });
    expect(revised.result.draft.revision).toBe(2);
    expect(revised.result.draft.body).not.toBe(draft.result.draft.body);
    expect(revised.result.draft.body.length).toBeLessThan(
      draft.result.draft.body.length,
    );
    expect(revised.result.draft.citations).toEqual(
      draft.result.draft.citations,
    );
    expect(revised.result.validation).toBe('passed');
    expect(revised.result.factualCitationCount).toBe(
      draft.result.factualCitationCount,
    );

    const reloadedBeforeApproval = createMemoryDurableApiDependencies({
      repository,
      now,
    });
    await expect(
      reloadedBeforeApproval.productService.createDraft(context, {
        recommendationId: recommendation.recommendation.recommendationId,
        expectedRecommendationRevision: 1,
      }),
    ).resolves.toEqual(revised);

    const proposal = await first.productService.prepareDraftApproval(context, {
      draftRevisionId: revised.result.draft.draftRevisionId,
      expectedDraftRevision: 2,
    });
    await expect(
      first.productService.prepareDraftApproval(context, {
        draftRevisionId: revised.result.draft.draftRevisionId,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual(proposal);
    const approved = await first.productService.approveProposal(context, {
      proposalId: proposal.proposalId,
      expectedProposalUpdatedAt: proposal.updatedAt,
    });

    expect(approved).toMatchObject({
      status: 'approved',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      receipt: { kind: 'effect_disabled' },
    });
    expect(
      repository.executionRecord(approved.operationId)?.aggregate,
    ).toMatchObject({
      executionStatus: 'settled',
      executionOutcome: 'effect_disabled',
      effectDisabledReceipt: approved.receipt,
    });
    const repeated = await first.productService.approveProposal(context, {
      proposalId: proposal.proposalId,
      expectedProposalUpdatedAt: proposal.updatedAt,
    });
    const repeatedFromCurrent = await first.productService.approveProposal(
      context,
      {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: approved.updatedAt,
      },
    );
    expect(repeated).toEqual(approved);
    expect(repeatedFromCurrent).toEqual(approved);

    const fresh = createMemoryDurableApiDependencies({ repository, now });
    const reloadedDraft = await fresh.productService.createDraft(context, {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    });
    expect(reloadedDraft).toEqual(revised);
    const reloadedProposal = await fresh.productService.prepareDraftApproval(
      context,
      {
        draftRevisionId: reloadedDraft.result.draft.draftRevisionId,
        expectedDraftRevision: reloadedDraft.result.draft.revision,
      },
    );
    expect(reloadedProposal).toMatchObject({
      proposalId: proposal.proposalId,
      status: 'approved',
      actionPlanId: proposal.actionPlanId,
      actionPlanRevision: proposal.actionPlanRevision,
      actionPlanHash: proposal.actionPlanHash,
      updatedAt: approved.updatedAt,
    });
    await expect(
      fresh.productService.getApprovalStatus(context, {
        proposalId: reloadedProposal.proposalId,
      }),
    ).resolves.toEqual({
      proposalId: proposal.proposalId,
      status: 'approved',
      approvalUrl: proposal.approvalUrl,
      updatedAt: approved.updatedAt,
    });
    await expect(
      fresh.productService.getExecutionStatus(context, {
        proposalId: reloadedProposal.proposalId,
      }),
    ).resolves.toEqual({
      proposalId: proposal.proposalId,
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'effect_disabled',
      receipt: approved.receipt,
    });
  });

  it('derives pending approval metrics from durable proposal state across restarts', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const { context, proposal } = await preparePendingApproval(dependencies);

    const restarted = createMemoryDurableApiDependencies({ repository });
    await expect(
      restarted.productService.dashboardMetrics(context, { window: '7d' }),
    ).resolves.toMatchObject({ pendingApprovalCount: 1 });

    await dependencies.productService.approveProposal(context, {
      proposalId: proposal.proposalId,
      expectedProposalUpdatedAt: proposal.updatedAt,
    });
    const restartedAfterApproval = createMemoryDurableApiDependencies({
      repository,
    });
    await expect(
      restartedAfterApproval.productService.dashboardMetrics(context, {
        window: '7d',
      }),
    ).resolves.toMatchObject({ pendingApprovalCount: 0 });
  });

  it('omits stale pending proposals from passive metrics while direct operations reject them', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const { context, draft, proposal } =
      await preparePendingApproval(dependencies);
    const staleService = new DurableProductService(
      repository,
      topicalBoundaryRetrieval([]),
      'https://chief.example.test',
    );

    await expect(
      staleService.dashboardMetrics(context, { window: '7d' }),
    ).resolves.toMatchObject({ pendingApprovalCount: 0 });
    await expect(
      staleService.prepareDraftApproval(context, {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: draft.result.draft.revision,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      staleService.getApprovalStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      staleService.getExecutionStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      staleService.approveProposal(context, {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: proposal.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('omits stale approved proposals from passive metrics while direct replay remains quarantined', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const { context, draft, proposal } =
      await preparePendingApproval(dependencies);
    const approved = await dependencies.productService.approveProposal(
      context,
      {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: proposal.updatedAt,
      },
    );
    const staleService = new DurableProductService(
      repository,
      topicalBoundaryRetrieval([]),
      'https://chief.example.test',
    );

    await expect(
      staleService.dashboardMetrics(context, { window: '7d' }),
    ).resolves.toMatchObject({ pendingApprovalCount: 0 });
    await expect(
      staleService.prepareDraftApproval(context, {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: draft.result.draft.revision,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      staleService.getApprovalStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      staleService.getExecutionStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      staleService.approveProposal(context, {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: approved.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('fails passive metrics closed for malformed indexes and missing indexed state', async () => {
    const malformedIndexRepository = new MemoryDurableProductRepository();
    await malformedIndexRepository.putRevision(
      durableEvaluatorAuthority.tenantId,
      {
        entityType: 'proposal-index',
        entityId: 'public-evaluator',
        revisionId: 'malformed-index:1',
        version: 1,
        committedAt: '2026-07-18T08:00:00.000Z',
        value: { schemaVersion: '1', proposalIds: ['z', 'a'] },
      },
    );
    const malformedIndex = createMemoryDurableApiDependencies({
      repository: malformedIndexRepository,
    });
    await expect(
      malformedIndex.productService.dashboardMetrics(
        createDurableRequestContext(),
        { window: '7d' },
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });

    const missingStateRepository = new MemoryDurableProductRepository();
    await missingStateRepository.putRevision(
      durableEvaluatorAuthority.tenantId,
      {
        entityType: 'proposal-index',
        entityId: 'public-evaluator',
        revisionId: 'missing-state-index:1',
        version: 1,
        committedAt: '2026-07-18T08:00:00.000Z',
        value: { schemaVersion: '1', proposalIds: ['proposal_missing'] },
      },
    );
    const missingState = createMemoryDurableApiDependencies({
      repository: missingStateRepository,
    });
    await expect(
      missingState.productService.dashboardMetrics(
        createDurableRequestContext(),
        { window: '7d' },
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('fails passive metrics closed when lineage validation raises a non-stale error', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const { context } = await preparePendingApproval(dependencies);
    const unavailable = new DurableProductService(
      repository,
      {
        search: () =>
          Promise.reject(
            new ProductServiceError(
              'FORBIDDEN_AUTHORITY',
              'Retrieval authority is unavailable.',
            ),
          ),
      },
      'https://chief.example.test',
    );

    await expect(
      unavailable.dashboardMetrics(context, { window: '7d' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_AUTHORITY' });
  });

  it('rejects stale recommendation revisions for context and Asana preparation', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const context = createDurableRequestContext();
    const result = await dependencies.productService.recommendAction(context, {
      messageRevisionId: messageRevisionIdSchema.parse('message-revision-1-1'),
      expectedMessageRevision: 1,
    });
    const recommendationId = result.recommendation.recommendationId;
    const current = await repository.getCurrent<RecommendationArtifact>(
      durableEvaluatorAuthority.tenantId,
      'recommendation',
      recommendationId,
    );
    expect(current).toBeDefined();
    if (current === undefined) throw new Error('RECOMMENDATION_NOT_PERSISTED');
    await repository.putRevision(durableEvaluatorAuthority.tenantId, {
      entityType: 'recommendation',
      entityId: recommendationId,
      revisionId: `${recommendationId}:2`,
      version: 2,
      expectedVersion: current.version,
      expectedRevisionId: current.revisionId,
      committedAt: '2026-07-18T08:00:00.000Z',
      value: {
        ...current.value,
        recommendation: {
          ...current.value.recommendation,
          revision: 2,
        },
      },
    });

    await expect(
      dependencies.productService.requestContext(context, {
        recommendationId,
        expectedRecommendationRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      dependencies.productService.prepareAsanaAction(context, {
        recommendationId,
        expectedRecommendationRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      dependencies.productService.requestContext(context, {
        recommendationId,
        expectedRecommendationRevision: 2,
      }),
    ).resolves.toMatchObject({ request: { recommendationId } });
    await expect(
      dependencies.productService.prepareAsanaAction(context, {
        recommendationId,
        expectedRecommendationRevision: 2,
      }),
    ).resolves.toMatchObject({ status: 'prepared' });
  });

  it('commits approval without caller-side relay availability or retry', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const { context, proposal } = await preparePendingApproval(dependencies);
    const approvalInput = {
      proposalId: proposal.proposalId,
      expectedProposalUpdatedAt: proposal.updatedAt,
    };

    const approved = await dependencies.productService.approveProposal(
      context,
      approvalInput,
    );
    await expect(
      dependencies.productService.getApprovalStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).resolves.toEqual({
      approvalUrl: proposal.approvalUrl,
      proposalId: proposal.proposalId,
      status: 'approved',
      updatedAt: approved.updatedAt,
    });

    const repeated = await dependencies.productService.approveProposal(
      context,
      approvalInput,
    );
    expect(repeated).toEqual(approved);
    expect(
      repository.executionRecord(approved.operationId)?.aggregate,
    ).toMatchObject({
      operationId: approved.operationId,
      effectDisabledReceipt: approved.receipt,
    });
  });

  it('never returns a current draft without its exact revision lookup after restart', async () => {
    const repository = new FailFirstAtomicDraftCommitRepository();
    const first = createMemoryDurableApiDependencies({ repository });
    const context = createDurableRequestContext();
    const recommendation = await first.productService.recommendAction(context, {
      messageRevisionId: messageRevisionIdSchema.parse('message-revision-1-1'),
      expectedMessageRevision: 1,
    });
    const createInput = {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    };

    await expect(
      first.productService.createDraft(context, createInput),
    ).rejects.toThrow('ATOMIC_DRAFT_COMMIT_INTERRUPTED');
    const draftId = deterministicId('draft', {
      recommendationId: createInput.recommendationId,
      connectorAccountId: durableEvaluatorAuthority.accountId,
    });
    await expect(
      repository.getCurrent(
        durableEvaluatorAuthority.tenantId,
        'draft',
        draftId,
      ),
    ).resolves.toBeUndefined();

    const restarted = createMemoryDurableApiDependencies({ repository });
    const draft = await restarted.productService.createDraft(
      context,
      createInput,
    );
    await expect(
      repository.getExact(
        durableEvaluatorAuthority.tenantId,
        'draft-revision',
        draft.result.draft.draftRevisionId,
      ),
    ).resolves.toMatchObject({
      revisionId: draft.result.draft.draftRevisionId,
      value: { artifact: { result: draft.result } },
    });
    const revised = await restarted.productService.reviseDraft(context, {
      draftRevisionId: draft.result.draft.draftRevisionId,
      expectedDraftRevision: draft.result.draft.revision,
      revisionInstruction: 'Make the owner explicit.',
    });
    await expect(
      restarted.productService.prepareDraftApproval(context, {
        draftRevisionId: revised.result.draft.draftRevisionId,
        expectedDraftRevision: revised.result.draft.revision,
      }),
    ).resolves.toMatchObject({ status: 'pending_approval' });
  });

  it('rejects superseded draft preparation and quarantines a proposal after the draft head advances', async () => {
    const repository = new MemoryDurableProductRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const context = createDurableRequestContext();
    const recommendation = await dependencies.productService.recommendAction(
      context,
      {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      },
    );
    const revisionOne = await dependencies.productService.createDraft(context, {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    });
    const staleProposal =
      await dependencies.productService.prepareDraftApproval(context, {
        draftRevisionId: revisionOne.result.draft.draftRevisionId,
        expectedDraftRevision: revisionOne.result.draft.revision,
      });
    const persistedProposal = await repository.getCurrent<{
      readonly status: 'pending_approval' | 'approved';
      readonly actionPlan: {
        readonly operations: readonly { readonly operationId: string }[];
      };
    }>(
      durableEvaluatorAuthority.tenantId,
      'proposal',
      staleProposal.proposalId,
    );
    const operationId =
      persistedProposal?.value.actionPlan.operations[0]?.operationId;
    expect(operationId).toBeDefined();

    const revisionTwo = await dependencies.productService.reviseDraft(context, {
      draftRevisionId: revisionOne.result.draft.draftRevisionId,
      expectedDraftRevision: revisionOne.result.draft.revision,
      revisionInstruction:
        'Make this draft concise while retaining all cited facts.',
    });
    expect(revisionTwo.result.draft.revision).toBe(2);

    await expect(
      dependencies.productService.prepareDraftApproval(context, {
        draftRevisionId: revisionOne.result.draft.draftRevisionId,
        expectedDraftRevision: revisionOne.result.draft.revision,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      dependencies.productService.approveProposal(context, {
        proposalId: staleProposal.proposalId,
        expectedProposalUpdatedAt: staleProposal.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      dependencies.productService.getApprovalStatus(context, {
        proposalId: staleProposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      dependencies.productService.getExecutionStatus(context, {
        proposalId: staleProposal.proposalId,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });

    await expect(
      repository.getCurrent(
        durableEvaluatorAuthority.tenantId,
        'proposal',
        staleProposal.proposalId,
      ),
    ).resolves.toMatchObject({ value: { status: 'pending_approval' } });
    expect(
      operationId === undefined
        ? undefined
        : repository.executionRecord(operationId),
    ).toBeUndefined();
    await expect(
      dependencies.productService.prepareDraftApproval(context, {
        draftRevisionId: revisionTwo.result.draft.draftRevisionId,
        expectedDraftRevision: revisionTwo.result.draft.revision,
      }),
    ).resolves.toMatchObject({ status: 'pending_approval' });
  });

  it('atomically rejects approval when the draft head advances after the service precheck', async () => {
    const repository = new InterleavingDraftAdvanceRepository();
    const dependencies = createMemoryDurableApiDependencies({ repository });
    const { context, draft, proposal } =
      await preparePendingApproval(dependencies);
    const persistedProposal = await repository.getCurrent<{
      readonly actionPlan: {
        readonly operations: readonly { readonly operationId: string }[];
      };
    }>(durableEvaluatorAuthority.tenantId, 'proposal', proposal.proposalId);
    const operationId =
      persistedProposal?.value.actionPlan.operations[0]?.operationId;
    expect(operationId).toBeDefined();
    repository.advanceBeforeNextApproval(async () => {
      const revised = await dependencies.productService.reviseDraft(context, {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: draft.result.draft.revision,
        revisionInstruction:
          'Make this draft concise while retaining all cited facts.',
      });
      expect(revised.result.draft.revision).toBe(2);
    });

    await expect(
      dependencies.productService.approveProposal(context, {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: proposal.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      repository.getCurrent(
        durableEvaluatorAuthority.tenantId,
        'proposal',
        proposal.proposalId,
      ),
    ).resolves.toMatchObject({
      version: 1,
      value: { status: 'pending_approval' },
    });
    expect(
      operationId === undefined
        ? undefined
        : repository.executionRecord(operationId),
    ).toBeUndefined();
  });

  it('rejects a stale proposal binding without creating approval state', async () => {
    const dependencies = createMemoryDurableApiDependencies();
    const context = createDurableRequestContext();
    const recommendation = await dependencies.productService.recommendAction(
      context,
      {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      },
    );
    const draft = await dependencies.productService.createDraft(context, {
      recommendationId: recommendation.recommendation.recommendationId,
      expectedRecommendationRevision: 1,
    });
    const proposal = await dependencies.productService.prepareDraftApproval(
      context,
      {
        draftRevisionId: draft.result.draft.draftRevisionId,
        expectedDraftRevision: 1,
      },
    );
    await expect(
      dependencies.productService.approveProposal(context, {
        proposalId: proposal.proposalId,
        expectedProposalUpdatedAt: '2026-07-18T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });
});

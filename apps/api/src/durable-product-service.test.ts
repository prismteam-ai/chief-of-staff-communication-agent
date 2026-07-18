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
import type { RecommendationArtifact } from '@chief/agent/application-agent';
import { deterministicId } from '@chief/agent/canonical';

import {
  createDurableRequestContext,
  createMemoryDurableApiDependencies,
} from './aws-composition.js';
import type { ApiDependencies } from './context.js';
import {
  MemoryDurableProductRepository,
  type AtomicRevisionWithExactLookup,
} from './durable-product-repository.js';
import {
  durableEvaluatorAuthority,
  DurableProductService,
  type DurableRetrievalPort,
} from './durable-product-service.js';

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
    readonly sourceKind?: 'communication' | 'asana' | 'organization';
    readonly topic: 'release_readiness' | 'board_metrics' | 'event_logistics';
    readonly sourceId?: string;
  }[],
): DurableRetrievalPort {
  return {
    search: (_context, input) => {
      const selected = records.slice(0, input.limit);
      const citations = selected.map(
        ({ key, sourceKind, sourceId: suppliedSourceId }, index) => {
          const sourceId =
            suppliedSourceId ??
            `source-${sourceKind ?? 'communication'}-${key}`;
          return citationSchema.parse({
            citationId: `${sourceId}:chunk-${key}:1`,
            sourceId,
            sourceVersion: '1',
            chunkId: `chunk-${key}`,
            label: `${key} communication evidence`,
            contentHash: String(index + 1).repeat(64),
            hydratedUnderAuthorizationEpoch: 1,
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
              authorizationEpoch: 1,
            });
          },
        ),
        citations,
        snapshotManifestHash: 'e'.repeat(64),
        evidence: selected.map(
          ({ key, text, exactEntityRef, sourceKind, topic }, index) => ({
            chunkId: `chunk-${key}`,
            citationId: citations[index]?.citationId as string,
            text,
            exactEntityRefs: [exactEntityRef],
            sourceClass:
              sourceKind === 'organization'
                ? ('organization_knowledge' as const)
                : (sourceKind ?? 'communication'),
            relation: {
              verified: true as const,
              kind:
                sourceKind === 'asana'
                  ? ('explicit_related_work' as const)
                  : ('canonical_message' as const),
              topic,
              exactEntityRefs: [exactEntityRef],
            },
          }),
        ),
      });
    },
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
        contentHash: String(index + 1).repeat(64),
        hydratedUnderAuthorizationEpoch: 1,
      }),
    );
    const retrieval: DurableRetrievalPort = {
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
          snapshotManifestHash: 'f'.repeat(64),
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
      confidence: 0.67,
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
        confidence: 0.72,
        citationSources: [
          'source-asana-word-but-typed-communication',
          'source-asana-1',
        ],
      },
      {
        messageRevisionId: 'message-revision-2-1',
        included: /Directors|governance|board|pipeline/iu,
        excluded: /Friday launch|QA owner|SEC-4821/iu,
        requiredText:
          'Directors approved the sales outlook for the quarterly governance pack.',
        confidence: 0.67,
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
      ).toEqual(
        scenario.messageRevisionId === 'message-revision-1-1'
          ? ['SEC-4821']
          : [],
      );
    }
  });

  it('abstains when only one exact topically relevant fact remains', async () => {
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
      actionType: 'request_context',
      confidence: 0.55,
      status: 'needs_context',
    });
    expect(result.recommendation.citations).toHaveLength(1);
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

  it('does not let a fixed citation ID with mismatched source content suppress canonical related work', async () => {
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
    const result = await service.recommendAction(
      createDurableRequestContext(),
      {
        messageRevisionId: messageRevisionIdSchema.parse(
          'message-revision-1-1',
        ),
        expectedMessageRevision: 1,
      },
    );
    expect(result.recommendation.citations).toHaveLength(2);
    expect(result.recommendation.citations.at(-1)).toMatchObject({
      citationId: 'source-asana-1:chunk-asana-1:1',
      contentHash:
        'a1c0ea6ff7436f8a17de74e2803aa8f318b5d42b3b6594dfcaeac4489ca08f81',
    });
  });

  it('does not treat an ingestion-proven Asana object using the launch thread ref as communication evidence', async () => {
    const launchRef =
      deterministicEvaluatorIdentityV1.communications[0]
        .retrievalExactEntityRef;
    const asanaCitation = citationSchema.parse({
      citationId: 'canonical-asana-spoof:chunk-asana-spoof:1',
      sourceId: 'canonical-asana-spoof',
      sourceVersion: '1',
      chunkId: 'chunk-asana-spoof',
      label: 'Canonical Asana evidence',
      contentHash: '8'.repeat(64),
      hydratedUnderAuthorizationEpoch: 1,
    });
    const retrieval: DurableRetrievalPort = {
      search: () =>
        Promise.resolve({
          candidates: [
            retrievalCandidateSchema.parse({
              chunkId: asanaCitation.chunkId,
              sourceId: asanaCitation.sourceId,
              lexicalScore: 1,
              vectorScore: 1,
              fusedScore: 1,
              authorizationEpoch: 1,
            }),
          ],
          citations: [asanaCitation],
          snapshotManifestHash: '7'.repeat(64),
          evidence: [
            {
              chunkId: asanaCitation.chunkId,
              citationId: asanaCitation.citationId,
              text: 'Operational sign-off before exposing the new version.',
              exactEntityRefs: [launchRef],
              sourceClass: 'asana' as const,
              relation: {
                verified: true as const,
                kind: 'explicit_related_work' as const,
                exactEntityRefs: [launchRef],
              },
            },
          ],
        }),
    };
    const service = new DurableProductService(
      new MemoryDurableProductRepository(),
      retrieval,
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
      actionType: 'request_context',
      status: 'needs_context',
    });
    expect(result.recommendation.citations).toHaveLength(1);
    expect(result.recommendation.citations[0]?.citationId).toBe(
      'source-asana-1:chunk-asana-1:1',
    );
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
    const queued: string[] = [];
    const first = createMemoryDurableApiDependencies({
      repository,
      now,
      operationQueue: {
        enqueue: (operationId) => {
          queued.push(operationId);
          return Promise.resolve();
        },
      },
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
      'The Friday launch decision is pending confirmation of the QA owner.',
      'Launch readiness task SEC-4821 tracks the QA owner commitment.',
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
    expect(queued).toEqual([
      approved.operationId,
      approved.operationId,
      approved.operationId,
    ]);

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

  it('keeps committed approval readable and retries stable queue delivery', async () => {
    const repository = new MemoryDurableProductRepository();
    let queueAttempts = 0;
    const dependencies = createMemoryDurableApiDependencies({
      repository,
      operationQueue: {
        enqueue: () => {
          queueAttempts += 1;
          return queueAttempts === 1
            ? Promise.reject(new Error('SQS_UNAVAILABLE'))
            : Promise.resolve();
        },
      },
    });
    const { context, proposal } = await preparePendingApproval(dependencies);
    const approvalInput = {
      proposalId: proposal.proposalId,
      expectedProposalUpdatedAt: proposal.updatedAt,
    };

    await expect(
      dependencies.productService.approveProposal(context, approvalInput),
    ).rejects.toThrow('SQS_UNAVAILABLE');
    await expect(
      dependencies.productService.getApprovalStatus(context, {
        proposalId: proposal.proposalId,
      }),
    ).resolves.toMatchObject({ status: 'approved' });

    const retried = await dependencies.productService.approveProposal(
      context,
      approvalInput,
    );
    const repeated = await dependencies.productService.approveProposal(
      context,
      approvalInput,
    );
    expect(repeated).toEqual(retried);
    expect(queueAttempts).toBe(3);
    expect(
      repository.executionRecord(retried.operationId)?.aggregate,
    ).toMatchObject({
      operationId: retried.operationId,
      effectDisabledReceipt: retried.receipt,
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

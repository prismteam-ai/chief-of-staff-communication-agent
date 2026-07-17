import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import {
  createDraftResultSchema,
  getApprovalStatusResultSchema,
  getCommunicationResultSchema,
  getConnectorStatusResultSchema,
  getRelatedAsanaWorkResultSchema,
  getSlaMetricsResultSchema,
  getThreadContextResultSchema,
  listCommunicationsResultSchema,
  prepareAsanaActionResultSchema,
  recommendActionResultSchema,
  requestContextResultSchema,
  reviseDraftResultSchema,
  searchKnowledgeResultSchema,
  serverRequestContextSchema,
  submitApprovalResultSchema,
} from '@chief/contracts';
import { createObservability } from '@chief/observability';

import {
  createFixtureProductService,
  createFixtureRequestContext,
  fixtureProductReferences,
} from './fixture-product-service.js';
import {
  dashboardMetricsResultSchema,
  executionStatusResultSchema,
  type ProductRequestContext,
} from './product-service.js';
import { appRouter } from './router.js';

function createCaller(
  requestContext: ProductRequestContext = createFixtureRequestContext(),
) {
  return appRouter.createCaller({
    event: {} as never,
    lambdaContext: {} as never,
    observability: createObservability('chief-api-test'),
    productService: createFixtureProductService(),
    requestContext,
  });
}

describe('typed product router', () => {
  it('serves the complete fixture-backed product surface with schema parity', async () => {
    const caller = createCaller();

    await expect(caller.system.health()).resolves.toMatchObject({
      service: 'chief-api',
      status: 'ok',
      foundationOnly: false,
    });

    const dashboard = dashboardMetricsResultSchema.parse(
      await caller.dashboard.metrics({ window: '24h' }),
    );
    expect(dashboard.totalCommunications).toBe(5);
    expect(
      dashboard.channelBreakdown.reduce((total, item) => total + item.count, 0),
    ).toBe(dashboard.totalCommunications);
    expect(dashboard.channelBreakdown).toEqual(
      expect.arrayContaining([
        { channel: 'email', count: 4 },
        { channel: 'sms', count: 1 },
      ]),
    );
    expect(dashboard.channelBreakdown).not.toContainEqual(
      expect.objectContaining({ channel: 'asana' }),
    );
    expect(
      getSlaMetricsResultSchema.parse(
        await caller.dashboard.sla({ window: '24h' }),
      ).snapshot.responseTimeP95Ms,
    ).toBeLessThan(180_000);

    const pageOne = listCommunicationsResultSchema.parse(
      await caller.communications.list({ limit: 2 }),
    );
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.nextCursor).toBeDefined();
    const pageTwo = listCommunicationsResultSchema.parse(
      await caller.communications.list({
        limit: 2,
        cursor: pageOne.nextCursor,
      }),
    );
    expect(pageTwo.items[0]?.messageRevisionId).not.toBe(
      pageOne.items[0]?.messageRevisionId,
    );
    const allCommunications = await caller.communications.list({ limit: 100 });
    const inboundRecommendations = await Promise.all(
      allCommunications.items
        .filter(({ direction }) => direction === 'inbound')
        .map(({ messageRevisionId, revision }) =>
          caller.agent.recommend({
            messageRevisionId,
            expectedMessageRevision: revision,
          }),
        ),
    );
    expect(inboundRecommendations).toHaveLength(4);

    const communication = getCommunicationResultSchema.parse(
      await caller.communications.get({
        messageRevisionId: 'message-revision-1-1',
      }),
    );
    expect(communication.communication.citations).toHaveLength(1);
    expect(
      getThreadContextResultSchema.parse(
        await caller.communications.thread({ threadId: 'thread-1', limit: 10 }),
      ).thread.communications,
    ).toHaveLength(2);
    expect(
      getThreadContextResultSchema.parse(
        await caller.communications.thread({ threadId: 'thread-3', limit: 10 }),
      ).thread.channel,
    ).toBe('sms');

    const connectors = getConnectorStatusResultSchema.parse(
      await caller.connectors.status({}),
    ).connectors;
    expect(connectors).toHaveLength(4);
    expect(
      connectors.every(({ capabilities }) => !capabilities.externalEffect),
    ).toBe(true);
    expect(
      getRelatedAsanaWorkResultSchema.parse(
        await caller.work.relatedAsana({
          messageRevisionId: 'message-revision-1-1',
          limit: 5,
        }),
      ).items,
    ).toHaveLength(2);

    const search = searchKnowledgeResultSchema.parse(
      await caller.knowledge.search({
        queryText: 'launch',
        exactEntityRefs: [],
        limit: 5,
      }),
    );
    expect(search.citations.length).toBeGreaterThan(0);
    expect(search.candidates[0]?.authorizationEpoch).toBe(1);

    const recommendation = recommendActionResultSchema.parse(
      await caller.agent.recommend({
        messageRevisionId: 'message-revision-1-1',
        expectedMessageRevision: 1,
      }),
    ).recommendation;
    expect(recommendation.citations).toHaveLength(2);
    expect(recommendation.citations[0]?.label).toContain('SEC-4821');
    const draft = createDraftResultSchema.parse(
      await caller.agent.createDraft({
        recommendationId: recommendation.recommendationId,
        expectedRecommendationRevision: recommendation.revision,
      }),
    ).result;
    const revised = reviseDraftResultSchema.parse(
      await caller.agent.reviseDraft({
        draftRevisionId: draft.draft.draftRevisionId,
        expectedDraftRevision: draft.draft.revision,
        revisionInstruction: 'Make the commitment more concise.',
      }),
    ).result;
    expect(revised.draft.revision).toBe(2);
    expect(revised.draft.supersedesRevisionId).toBe(
      draft.draft.draftRevisionId,
    );
    await expect(
      caller.agent.reviseDraft({
        draftRevisionId: draft.draft.draftRevisionId,
        expectedDraftRevision: draft.draft.revision,
        revisionInstruction: 'Try to edit the superseded revision.',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      requestContextResultSchema.parse(
        await caller.agent.requestContext({
          recommendationId: 'recommendation-2',
          expectedRecommendationRevision: 1,
        }),
      ).request.state,
    ).toBe('open');

    const proposal = submitApprovalResultSchema.parse(
      await caller.approvals.prepare({
        actionPlanId: fixtureProductReferences.actionPlanId,
        expectedActionPlanRevision: fixtureProductReferences.actionPlanRevision,
        actionPlanHash: fixtureProductReferences.actionPlanHash,
      }),
    );
    expect(proposal.directEffectAvailable).toBe(false);
    expect(
      getApprovalStatusResultSchema.parse(
        await caller.approvals.status({ proposalId: proposal.proposalId }),
      ).status,
    ).toBe('pending_approval');
    expect(
      prepareAsanaActionResultSchema.parse(
        await caller.approvals.prepareAsana({
          recommendationId: 'recommendation-3',
          expectedRecommendationRevision: 1,
        }),
      ).directEffectAvailable,
    ).toBe(false);

    const execution = executionStatusResultSchema.parse(
      await caller.execution.status({
        proposalId: fixtureProductReferences.effectDisabledProposalId,
      }),
    );
    expect(execution).toMatchObject({
      runtimeMode: 'fixture',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'effect_disabled',
      receipt: { kind: 'effect_disabled' },
    });
    expect(
      getApprovalStatusResultSchema.parse(
        await caller.approvals.status({
          proposalId: fixtureProductReferences.effectDisabledProposalId,
        }),
      ).status,
    ).toBe('approved');
  });

  it('uses opaque filter-bound cursors and rejects stale revisions', async () => {
    const caller = createCaller();
    const pending = await caller.communications.list({
      status: 'pending',
      limit: 1,
    });

    await expect(
      caller.communications.list({
        status: 'overdue',
        limit: 1,
        cursor: pending.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.agent.recommend({
        messageRevisionId: 'message-revision-1-1',
        expectedMessageRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller.approvals.prepare({
        actionPlanId: fixtureProductReferences.actionPlanId,
        expectedActionPlanRevision: 2,
        actionPlanHash: fixtureProductReferences.actionPlanHash,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects caller-selected authority, malformed input, and oversized payloads', async () => {
    const caller = createCaller();

    await expect(
      caller.communications.list({
        limit: 10,
        tenantId: 'tenant-attacker',
      } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.connectors.status({ accountId: 'account-attacker' } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.knowledge.search({
        queryText: 'x'.repeat(16_001),
        exactEntityRefs: [],
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.knowledge.search({
        queryText: '   ',
        exactEntityRefs: [],
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.agent.reviseDraft({
        draftRevisionId: '',
        expectedDraftRevision: 0,
        revisionInstruction: '',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('fails closed on same-tenant public authority-envelope substitutions', async () => {
    const baseline = createFixtureRequestContext();
    const attackerContexts = [
      serverRequestContextSchema.parse({
        ...baseline,
        actor: { ...baseline.actor, userId: 'user-attacker' },
      }),
      serverRequestContextSchema.parse({
        ...baseline,
        actor: {
          ...baseline.actor,
          accountScopes: ['account-attacker'],
        },
      }),
      serverRequestContextSchema.parse({
        ...baseline,
        actor: { ...baseline.actor, brandScopes: ['brand-attacker'] },
      }),
      serverRequestContextSchema.parse({
        ...baseline,
        actor: { ...baseline.actor, grants: ['metrics:read'] },
      }),
      serverRequestContextSchema.parse({
        ...baseline,
        retrievalScope: {
          ...baseline.retrievalScope,
          authorizationEpoch: 2,
        },
      }),
      serverRequestContextSchema.parse({
        ...baseline,
        retrievalScope: {
          ...baseline.retrievalScope,
          accountIds: ['account-attacker'],
          brandIds: ['brand-attacker'],
        },
      }),
    ];

    for (const attackerContext of attackerContexts) {
      await expect(
        createCaller(attackerContext).communications.list({ limit: 1 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('requires a credential-free HTTPS product origin', () => {
    expect(() =>
      createFixtureProductService('https://chief.example.test/'),
    ).not.toThrow();
    for (const unsafeUrl of [
      'http://chief.example.test',
      'https://user:pass@chief.example.test',
      'https://chief.example.test/product',
      'https://chief.example.test/.',
      'https://chief.example.test?token=secret',
      'https://chief.example.test?',
      'https://chief.example.test#approval',
      'not-a-url',
    ]) {
      expect(() => createFixtureProductService(unsafeUrl)).toThrow(
        'credential-free HTTPS origin',
      );
    }
  });

  it('has no direct approval, provider-send, or Asana-mutation procedure', () => {
    const definition = appRouter as unknown as {
      _def: {
        record: Record<string, unknown>;
        procedures: Record<string, unknown>;
      };
    };
    const procedures = Object.keys(definition._def.procedures);
    const serialized = JSON.stringify(procedures);

    expect(serialized).not.toMatch(/send|approve|createTask|updateTask/iu);
    expect(procedures).toEqual(
      expect.arrayContaining([
        'agent.createDraft',
        'approvals.prepare',
        'communications.list',
        'execution.status',
      ]),
    );
    expect(Object.keys(definition._def.record)).toEqual(
      expect.arrayContaining([
        'agent',
        'approvals',
        'communications',
        'execution',
        'knowledge',
      ]),
    );
  });
});

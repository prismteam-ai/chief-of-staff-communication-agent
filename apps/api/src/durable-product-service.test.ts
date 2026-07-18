import { describe, expect, it } from 'vitest';
import {
  deterministicEvaluatorIdentityV1,
  messageRevisionIdSchema,
  serverRequestContextSchema,
  tenantIdSchema,
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

describe('durable hosted product vertical', () => {
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

import { createHash } from 'node:crypto';

import type {
  DraftArtifact,
  RecommendationArtifact,
} from '@chief/agent/application-agent';
import { deterministicId } from '@chief/agent/canonical';

import {
  attemptIdSchema,
  citationSchema,
  communicationDetailViewSchema,
  communicationSummaryViewSchema,
  connectorStatusViewSchema,
  connectorSnapshotSchema,
  contextRequestSchema,
  deterministicEvaluatorIdentityV1,
  getApprovalStatusResultSchema,
  getCommunicationResultSchema,
  getConnectorStatusResultSchema,
  getRelatedAsanaWorkResultSchema,
  getSlaMetricsResultSchema,
  getThreadContextResultSchema,
  listCommunicationsResultSchema,
  proposalHandoffSchema,
  searchKnowledgeResultSchema,
  serverRequestContextSchema,
  threadContextViewSchema,
  workObjectFactSchema,
  type ActionPlan,
  type CommunicationDetailView,
  type CommunicationSummaryView,
  type ConnectorStatusView,
  type Citation,
  type RetrievalCandidate,
} from '@chief/contracts';
import {
  buildImmutableApprovalBundle,
  type OperationApprovalBinding,
} from '@chief/approval-outbox/approval-service';
import {
  buildDynamoApprovalExecutionRecords,
  type DynamoApprovalExecutionRecords,
} from '@chief/approval-outbox/dynamo-execution-persistence';
import { canonicalSha256 } from '@chief/approval-outbox/canonical';
import { PersistenceConflictError } from '@chief/persistence-dynamodb';
import type { AuthoritativeExecutionState } from '@chief/approval-outbox/execution-service';
import { createDeterministicDurableAgent } from './deterministic-agent-runtime.js';
import type { DurableProductRepository } from './durable-product-repository.js';
import {
  approveProposalResultSchema,
  dashboardMetricsResultSchema,
  executionStatusResultSchema,
  prepareDraftApprovalResultSchema,
  ProductServiceError,
  type ApproveProposalResult,
  type DashboardMetricsResult,
  type ExecutionStatusResult,
  type PrepareDraftApprovalResult,
  type ProductRequestContext,
  type ProductService,
} from './product-service.js';

const TENANT_ID = deterministicEvaluatorIdentityV1.tenantId;
const USER_ID = deterministicEvaluatorIdentityV1.userId;
const ACCOUNT_ID = deterministicEvaluatorIdentityV1.accountId;
const BRAND_ID = deterministicEvaluatorIdentityV1.brandId;
const SEED_AT = '2026-07-17T12:00:00.000Z';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const RECIPIENT_DIGEST = `h1_v1_${'A'.repeat(43)}`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function id(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalSha256(value).slice(0, 40)}`;
}

function productUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/u, '')}${path}`;
}

export interface DurableRetrievalResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly citations: readonly Citation[];
  readonly snapshotManifestHash: string;
  readonly evidence: readonly {
    readonly chunkId: string;
    readonly citationId: string;
    readonly text: string;
  }[];
}

export interface DurableRetrievalPort {
  search(
    context: ProductRequestContext,
    input: {
      readonly queryText: string;
      readonly exactEntityRefs: readonly string[];
      readonly limit: number;
    },
  ): Promise<DurableRetrievalResult>;
}

export interface OperationQueue {
  enqueue(operationId: string): Promise<void>;
}

interface SeedProjection {
  readonly communications: readonly CommunicationSummaryView[];
  readonly details: readonly CommunicationDetailView[];
  readonly connectors: readonly ConnectorStatusView[];
}

interface StoredDraft {
  readonly artifact: DraftArtifact;
  readonly recommendationId: string;
}

interface StoredProposal {
  readonly proposalId: string;
  readonly draftRevisionId: string;
  readonly actionPlan: ActionPlan;
  readonly status: 'pending_approval' | 'approved';
  readonly approvalUrl: string;
  readonly updatedAt: string;
  readonly approvalId?: string;
  readonly operationId?: string;
  readonly receipt?: ApproveProposalResult['receipt'];
  readonly approvedFromUpdatedAt?: string;
}

function citation(sourceId: string, chunkId: string, label: string): Citation {
  return citationSchema.parse({
    citationId: `${sourceId}:${chunkId}:1`,
    sourceId,
    sourceVersion: '1',
    chunkId,
    label,
    contentHash: sha256(`${sourceId}:${chunkId}:${label}`),
    hydratedUnderAuthorizationEpoch: 1,
  });
}

function createSeed(baseUrl: string): SeedProjection {
  const launchIdentity = deterministicEvaluatorIdentityV1.communications[0];
  const boardIdentity = deterministicEvaluatorIdentityV1.communications[1];
  const summaries = [
    communicationSummaryViewSchema.parse({
      messageId: launchIdentity.messageId,
      messageRevisionId: launchIdentity.messageRevisionId,
      revision: 1,
      threadId: launchIdentity.productThreadAlias,
      direction: 'inbound',
      status: 'overdue',
      senderDisplayName: 'Jordan Lee',
      recipientDisplayNames: ['Public evaluator'],
      subject: 'Friday launch decision',
      excerpt: 'Can we confirm the Friday launch and the owner for QA?',
      attachmentCount: 0,
      sourceTimestamp: '2026-07-17T10:52:00.000Z',
      productUrl: productUrl(baseUrl, '/communications/message-revision-1-1'),
    }),
    communicationSummaryViewSchema.parse({
      messageId: boardIdentity.messageId,
      messageRevisionId: boardIdentity.messageRevisionId,
      revision: 1,
      threadId: boardIdentity.productThreadAlias,
      direction: 'inbound',
      status: 'pending',
      senderDisplayName: 'Priya Shah',
      recipientDisplayNames: ['Public evaluator'],
      subject: 'Board update numbers',
      excerpt: 'Please send the approved pipeline numbers for the board note.',
      attachmentCount: 0,
      sourceTimestamp: '2026-07-17T11:06:00.000Z',
      productUrl: productUrl(baseUrl, '/communications/message-revision-2-1'),
    }),
  ];
  const details = summaries.map((summary, index) =>
    communicationDetailViewSchema.parse({
      ...summary,
      authoredText: summary.excerpt,
      normalizedText: summary.excerpt,
      attachments: [],
      citations: [
        citation(
          `source-communication-${index + 1}`,
          `chunk-communication-${index + 1}`,
          summary.subject ?? 'Communication',
        ),
      ],
    }),
  );
  const connectors = [
    connectorStatusViewSchema.parse({
      accountId: ACCOUNT_ID,
      brandId: BRAND_ID,
      connectorId: deterministicEvaluatorIdentityV1.connector.connectorId,
      displayLabel: 'Deterministic evaluator Gmail data',
      provider: 'gmail',
      connectorKind: 'communication',
      channel: 'email',
      status: 'active',
      health: 'healthy',
      runtimeMode: deterministicEvaluatorIdentityV1.connector.runtimeMode,
      selectionState: 'selected',
      capabilities: {
        read: true,
        send: false,
        webhook: false,
        poll: false,
        threads: true,
        attachments: true,
        deliveryFeedback: false,
        multipleAccounts: false,
        historicalBackfill: false,
        externalEffect: false,
        replyCorrelation: true,
        complaintFeedback: false,
        unsubscribeFeedback: false,
        optOutFeedback: false,
        reconsentFeedback: false,
        consentWindowEligibility: false,
      },
      lastSyncAt: SEED_AT,
      productUrl: productUrl(baseUrl, '/settings/connectors/gmail'),
    }),
  ];
  return { communications: summaries, details, connectors };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { offset?: unknown };
    if (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0)
      throw new Error('bad');
    return Number(value.offset);
  } catch {
    throw new ProductServiceError('BAD_CURSOR', 'The cursor is invalid.');
  }
}

export class DurableProductService implements ProductService {
  readonly #seed: SeedProjection;

  public constructor(
    private readonly repository: DurableProductRepository,
    private readonly retrieval: DurableRetrievalPort,
    private readonly baseUrl: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly operationQueue?: OperationQueue,
  ) {
    this.#seed = createSeed(baseUrl);
  }

  async #projection(context: ProductRequestContext): Promise<SeedProjection> {
    this.#assertContext(context);
    const existing = await this.repository.getCurrent<SeedProjection>(
      TENANT_ID,
      'hosted-projection',
      'public-evaluator',
    );
    if (existing !== undefined) return existing.value;
    await this.repository.putRevision(TENANT_ID, {
      entityType: 'hosted-projection',
      entityId: 'public-evaluator',
      revisionId: 'hosted-projection-v1',
      version: 1,
      committedAt: SEED_AT,
      value: this.#seed,
    });
    return (
      (
        await this.repository.getCurrent<SeedProjection>(
          TENANT_ID,
          'hosted-projection',
          'public-evaluator',
        )
      )?.value ?? this.#seed
    );
  }

  #assertContext(context: ProductRequestContext): void {
    const safe = serverRequestContextSchema.parse(context);
    if (
      safe.actor.tenantId !== TENANT_ID ||
      safe.actor.userId !== USER_ID ||
      !safe.actor.grants.includes('actions:approve') ||
      !safe.actor.accountScopes.includes(ACCOUNT_ID)
    ) {
      throw new ProductServiceError(
        'FORBIDDEN_AUTHORITY',
        'The fixed evaluator authority is required.',
      );
    }
  }

  public async dashboardMetrics(
    context: ProductRequestContext,
    input: { readonly window: '24h' | '7d' | '30d' },
  ): Promise<DashboardMetricsResult> {
    const projection = await this.#projection(context);
    const snapshot = (await this.getSlaMetrics(context, input)).snapshot;
    return dashboardMetricsResultSchema.parse({
      snapshot,
      totalCommunications: projection.communications.length,
      pendingApprovalCount: 0,
      channelBreakdown: [
        { channel: 'email', count: projection.communications.length },
      ],
    });
  }

  public async getSlaMetrics(
    context: ProductRequestContext,
    input: { readonly window: '24h' | '7d' | '30d' },
  ) {
    const projection = await this.#projection(context);
    const count = (status: string) =>
      projection.communications.filter((item) => item.status === status).length;
    return getSlaMetricsResultSchema.parse({
      snapshot: {
        schemaVersion: '1',
        window: input.window,
        measuredAt: SEED_AT,
        pendingCount: count('pending'),
        overdueCount: count('overdue'),
        answeredCount: count('answered'),
        resolvedCount: count('resolved'),
        responseTimeP50Ms: 42_000,
        responseTimeP95Ms: 118_000,
        ingestionLagP95Ms: 24_000,
      },
    });
  }

  public async listCommunications(
    context: ProductRequestContext,
    input: {
      readonly status?: 'pending' | 'answered' | 'overdue' | 'resolved';
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    const projection = await this.#projection(context);
    const all =
      input.status === undefined
        ? projection.communications
        : projection.communications.filter(
            ({ status }) => status === input.status,
          );
    const offset = decodeCursor(input.cursor);
    const items = all.slice(offset, offset + input.limit);
    const next = offset + items.length;
    return listCommunicationsResultSchema.parse({
      items,
      ...(next < all.length ? { nextCursor: encodeCursor(next) } : {}),
    });
  }

  public async getCommunication(
    context: ProductRequestContext,
    input: { readonly messageRevisionId: string },
  ) {
    const projection = await this.#projection(context);
    const communication = projection.details.find(
      ({ messageRevisionId }) => messageRevisionId === input.messageRevisionId,
    );
    if (communication === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Communication was not found.',
      );
    return getCommunicationResultSchema.parse({ communication });
  }

  public async getThreadContext(
    context: ProductRequestContext,
    input: {
      readonly threadId: string;
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    const projection = await this.#projection(context);
    const all = projection.communications.filter(
      ({ threadId }) => threadId === input.threadId,
    );
    if (all.length === 0)
      throw new ProductServiceError('NOT_FOUND', 'Thread was not found.');
    const offset = decodeCursor(input.cursor);
    const communications = all.slice(offset, offset + input.limit);
    const latest = all.at(-1) as CommunicationSummaryView;
    const thread = threadContextViewSchema.parse({
      threadId: input.threadId,
      channel: 'email',
      subject: all[0]?.subject,
      participantDisplayNames: ['Public evaluator'],
      status: 'active',
      latestMessageRevisionId: latest.messageRevisionId,
      sourceUpdatedAt: latest.sourceTimestamp,
      communications,
      productUrl: productUrl(this.baseUrl, `/threads/${input.threadId}`),
    });
    return getThreadContextResultSchema.parse({ thread });
  }

  public async getConnectorStatus(
    context: ProductRequestContext,
    input: { readonly connectorId?: string },
  ) {
    const projection = await this.#projection(context);
    return getConnectorStatusResultSchema.parse({
      connectors:
        input.connectorId === undefined
          ? projection.connectors
          : projection.connectors.filter(
              ({ connectorId }) => connectorId === input.connectorId,
            ),
    });
  }

  public async getRelatedAsanaWork(
    context: ProductRequestContext,
    input: { readonly messageRevisionId: string; readonly limit: number },
  ) {
    await this.getCommunication(context, input);
    return getRelatedAsanaWorkResultSchema.parse({
      items: [
        workObjectFactSchema.parse({
          kind: 'task',
          providerObjectId: 'SEC-4821',
          providerVersion: '1',
          providerTimestamp: SEED_AT,
          payloadFingerprint: sha256('SEC-4821'),
        }),
      ].slice(0, input.limit),
    });
  }

  public async searchKnowledge(
    context: ProductRequestContext,
    input: {
      readonly queryText: string;
      readonly exactEntityRefs: readonly string[];
      readonly limit: number;
    },
  ) {
    this.#assertContext(context);
    const result = await this.retrieval.search(context, input);
    return searchKnowledgeResultSchema.parse({
      candidates: result.candidates,
      citations: result.citations,
    });
  }

  public async recommendAction(
    context: ProductRequestContext,
    input: {
      readonly messageRevisionId: string;
      readonly expectedMessageRevision: number;
    },
  ) {
    const detail = (await this.getCommunication(context, input)).communication;
    if (detail.revision !== input.expectedMessageRevision)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Communication revision is stale.',
      );
    const agent = createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: this.retrieval,
      context,
      now: this.now,
    });
    const communicationIdentity =
      deterministicEvaluatorIdentityV1.communications.find(
        ({ messageRevisionId }) =>
          messageRevisionId === detail.messageRevisionId,
      );
    if (communicationIdentity === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Evaluator communication identity was not found.',
      );
    const artifact = await agent.recommend({
      tenantId: TENANT_ID,
      userId: USER_ID,
      brandId: BRAND_ID,
      sourceMessageRevisionId: detail.messageRevisionId,
      sourceMessageRevision: detail.revision,
      channel: 'email',
      subject: detail.subject,
      authoredText: detail.authoredText,
      scopeHash: context.retrievalScope?.scopeHash ?? sha256('missing-scope'),
      exactEntityRefs: [communicationIdentity.retrievalExactEntityRef],
      styleExamples: [
        {
          exampleId: 'approved-style-example-1',
          tenantId: TENANT_ID,
          userId: USER_ID,
          brandId: BRAND_ID,
          channel: 'email',
          body: 'Hi,\n\nThanks for the note. I will confirm today.\n\nThanks,',
          approvedAt: SEED_AT,
          approved: true,
        },
      ],
    });
    const recommendation = artifact.recommendation;
    const existing = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      recommendation.recommendationId,
    );
    if (existing !== undefined) {
      if (existing.value.immutableHash !== artifact.immutableHash)
        throw new ProductServiceError(
          'STALE_REVISION',
          'Recommendation replay conflicts with durable state.',
        );
      return { recommendation: existing.value.recommendation };
    }
    try {
      await this.repository.putRevision(TENANT_ID, {
        entityType: 'recommendation',
        entityId: recommendation.recommendationId,
        revisionId: `${recommendation.recommendationId}:1`,
        version: 1,
        committedAt: recommendation.createdAt,
        value: artifact,
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
    const persisted = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      recommendation.recommendationId,
    );
    if (
      persisted === undefined ||
      persisted.value.immutableHash !== artifact.immutableHash
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation write conflicted with durable state.',
      );
    return { recommendation: persisted.value.recommendation };
  }

  public async createDraft(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
    },
  ) {
    this.#assertContext(context);
    const stored = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      input.recommendationId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    if (
      stored.value.recommendation.revision !==
      input.expectedRecommendationRevision
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    const draftId = deterministicId('draft', {
      recommendationId: input.recommendationId,
      connectorAccountId: ACCOUNT_ID,
    });
    const currentDraft = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draftId,
    );
    if (currentDraft !== undefined) {
      if (currentDraft.value.recommendationId !== input.recommendationId)
        throw new ProductServiceError(
          'STALE_REVISION',
          'The persisted draft binding conflicts with the recommendation.',
        );
      await this.#assertExactDraftLookup(currentDraft.value);
      return { result: currentDraft.value.artifact.result };
    }
    const outcome = await createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: this.retrieval,
      context,
      now: this.now,
    }).createDraft({
      recommendation: stored.value,
      expectedRecommendationRevision: input.expectedRecommendationRevision,
      connectorAccountId: ACCOUNT_ID,
      recipientDigests: [RECIPIENT_DIGEST as never],
      subject: 'Friday launch decision',
    });
    if (outcome.kind !== 'ready')
      throw new ProductServiceError(
        'INVALID_INPUT',
        `Draft preparation ${outcome.kind}.`,
      );
    try {
      const persisted = await this.#persistDraft(
        outcome.artifact,
        input.recommendationId,
      );
      return { result: persisted.artifact.result };
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
      const winner = await this.repository.getCurrent<StoredDraft>(
        TENANT_ID,
        'draft',
        draftId,
      );
      if (winner?.value.recommendationId === input.recommendationId)
        return { result: winner.value.artifact.result };
      throw new ProductServiceError(
        'STALE_REVISION',
        'Draft creation conflicted with a newer durable head.',
      );
    }
  }

  async #persistDraft(
    artifact: DraftArtifact,
    recommendationId: string,
  ): Promise<StoredDraft> {
    const draft = artifact.result.draft;
    const current = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draft.draftId,
    );
    const value = { artifact, recommendationId } satisfies StoredDraft;
    await this.repository.putRevisionWithExactLookup(TENANT_ID, {
      revision: {
        entityType: 'draft',
        entityId: draft.draftId,
        revisionId: draft.draftRevisionId,
        version: draft.revision,
        committedAt: draft.createdAt,
        ...(current === undefined
          ? {}
          : {
              expectedVersion: current.version,
              expectedRevisionId: current.revisionId,
            }),
        value,
      },
      exactLookup: {
        entityType: 'draft-revision',
        entityId: draft.draftRevisionId,
        revisionId: draft.draftRevisionId,
        version: draft.revision,
        committedAt: draft.createdAt,
        value,
      },
    });
    const persisted = await this.repository.getCurrent<StoredDraft>(
      TENANT_ID,
      'draft',
      draft.draftId,
    );
    if (
      persisted === undefined ||
      persisted.revisionId !== draft.draftRevisionId ||
      persisted.value.recommendationId !== recommendationId
    )
      throw new PersistenceConflictError();
    await this.#assertExactDraftLookup(persisted.value);
    return persisted.value;
  }

  async #assertExactDraftLookup(stored: StoredDraft): Promise<void> {
    const draft = stored.artifact.result.draft;
    const exact = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      draft.draftRevisionId,
    );
    if (
      exact === undefined ||
      exact.revisionId !== draft.draftRevisionId ||
      exact.version !== draft.revision ||
      exact.value.recommendationId !== stored.recommendationId ||
      exact.value.artifact.immutableHash !== stored.artifact.immutableHash
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'The durable draft head has no matching immutable revision lookup.',
      );
  }

  public async reviseDraft(
    context: ProductRequestContext,
    input: {
      readonly draftRevisionId: string;
      readonly expectedDraftRevision: number;
      readonly revisionInstruction: string;
    },
  ) {
    this.#assertContext(context);
    const stored = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      input.draftRevisionId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Draft revision was not found.',
      );
    if (
      stored.value.artifact.result.draft.revision !==
      input.expectedDraftRevision
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Draft revision is stale.',
      );
    const recommendation =
      await this.repository.getCurrent<RecommendationArtifact>(
        TENANT_ID,
        'recommendation',
        stored.value.recommendationId,
      );
    if (recommendation === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    const outcome = await createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: this.retrieval,
      context,
      now: this.now,
    }).reviseDraft({
      recommendation: recommendation.value,
      expectedRecommendationRevision:
        recommendation.value.recommendation.revision,
      connectorAccountId: ACCOUNT_ID,
      recipientDigests: [RECIPIENT_DIGEST as never],
      subject: 'Friday launch decision',
      base: stored.value.artifact,
      expectedDraftRevision: input.expectedDraftRevision,
      revisionInstruction: input.revisionInstruction,
    });
    if (outcome.kind !== 'ready')
      throw new ProductServiceError(
        'INVALID_INPUT',
        `Draft revision ${outcome.kind}.`,
      );
    try {
      const persisted = await this.#persistDraft(
        outcome.artifact,
        stored.value.recommendationId,
      );
      return { result: persisted.artifact.result };
    } catch (error) {
      if (error instanceof PersistenceConflictError)
        throw new ProductServiceError(
          'STALE_REVISION',
          'Draft revision conflicted with a newer durable head.',
        );
      throw error;
    }
  }

  public async requestContext(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
      readonly focusedQuestion?: string;
    },
  ) {
    this.#assertContext(context);
    const stored = await this.repository.getCurrent<RecommendationArtifact>(
      TENANT_ID,
      'recommendation',
      input.recommendationId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    return {
      request: contextRequestSchema.parse({
        schemaVersion: '1',
        tenantId: TENANT_ID,
        contextRequestId: id('context', input.recommendationId),
        recommendationId: input.recommendationId,
        focusedQuestion:
          input.focusedQuestion ??
          'Which approved fact should determine the response?',
        missingFacts:
          stored.value.recommendation.missingFacts.length > 0
            ? stored.value.recommendation.missingFacts
            : ['user confirmation'],
        state: 'open',
        responseEvidenceRefs: [],
        createdAt: this.now(),
      }),
    };
  }

  public prepareApproval(): never {
    throw new ProductServiceError(
      'INVALID_INPUT',
      'Prepare approval from a persisted draft revision with approvals.prepareDraft.',
    );
  }

  public async prepareAsanaAction(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
    },
  ) {
    this.#assertContext(context);
    const recommendation =
      await this.repository.getCurrent<RecommendationArtifact>(
        TENANT_ID,
        'recommendation',
        input.recommendationId,
      );
    if (recommendation === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    return proposalHandoffSchema.parse({
      proposalId: id('proposal-asana', input.recommendationId),
      approvalUrl: productUrl(this.baseUrl, '/approvals'),
      status: 'prepared',
      directEffectAvailable: false,
    });
  }

  public async prepareDraftApproval(
    context: ProductRequestContext,
    input: {
      readonly draftRevisionId: string;
      readonly expectedDraftRevision: number;
    },
  ): Promise<PrepareDraftApprovalResult> {
    this.#assertContext(context);
    const stored = await this.repository.getExact<StoredDraft>(
      TENANT_ID,
      'draft-revision',
      input.draftRevisionId,
    );
    if (stored === undefined)
      throw new ProductServiceError(
        'NOT_FOUND',
        'Draft revision was not found.',
      );
    const draft = stored.value.artifact.result.draft;
    if (draft.revision !== input.expectedDraftRevision)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Draft revision is stale.',
      );
    const actionPlan = createDeterministicDurableAgent({
      repository: this.repository,
      retrieval: this.retrieval,
      context,
      now: this.now,
    }).prepareApprovalActionPlan({
      artifact: stored.value.artifact,
      policyVersion: 'effect-disabled-v1',
      expiresAt: EXPIRES_AT,
    });
    const actionPlanId = actionPlan.actionPlanId;
    const proposalId = id('proposal', { actionPlanId, revision: 1 });
    const existing = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      proposalId,
    );
    if (existing !== undefined) {
      if (
        existing.value.draftRevisionId !== draft.draftRevisionId ||
        existing.value.actionPlan.canonicalHash !== actionPlan.canonicalHash
      )
        throw new ProductServiceError(
          'STALE_REVISION',
          'The proposal binding conflicts with durable state.',
        );
      return this.#prepareApprovalResult(existing.value);
    }
    const updatedAt = this.now();
    const proposal: StoredProposal = {
      proposalId,
      draftRevisionId: draft.draftRevisionId,
      actionPlan,
      status: 'pending_approval',
      approvalUrl: productUrl(this.baseUrl, `/approvals/${proposalId}`),
      updatedAt,
    };
    try {
      await this.repository.putRevision(TENANT_ID, {
        entityType: 'proposal',
        entityId: proposalId,
        revisionId: `${proposalId}:pending`,
        version: 1,
        committedAt: updatedAt,
        value: proposal,
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
    const persisted = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      proposalId,
    );
    if (persisted === undefined) throw new Error('PROPOSAL_HEAD_NOT_PERSISTED');
    return this.#prepareApprovalResult(persisted.value);
  }

  #prepareApprovalResult(proposal: StoredProposal): PrepareDraftApprovalResult {
    return prepareDraftApprovalResultSchema.parse({
      proposalId: proposal.proposalId,
      approvalUrl: proposal.approvalUrl,
      status: proposal.status,
      directEffectAvailable: false,
      actionPlanId: proposal.actionPlan.actionPlanId,
      actionPlanRevision: proposal.actionPlan.revision,
      actionPlanHash: proposal.actionPlan.canonicalHash,
      updatedAt: proposal.updatedAt,
    });
  }

  public async approveProposal(
    context: ProductRequestContext,
    input: {
      readonly proposalId: string;
      readonly expectedProposalUpdatedAt: string;
    },
  ): Promise<ApproveProposalResult> {
    this.#assertContext(context);
    const current = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (current === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    const proposal = current.value;
    if (proposal.status === 'approved') {
      if (
        proposal.approvedFromUpdatedAt !== input.expectedProposalUpdatedAt &&
        proposal.updatedAt !== input.expectedProposalUpdatedAt
      )
        throw new ProductServiceError(
          'STALE_REVISION',
          'Proposal revision is stale.',
        );
      const result = this.#approvalResult(proposal);
      await this.operationQueue?.enqueue(result.operationId);
      return result;
    }
    if (proposal.updatedAt !== input.expectedProposalUpdatedAt)
      throw new ProductServiceError(
        'STALE_REVISION',
        'Proposal revision is stale.',
      );
    const operation = proposal.actionPlan.operations[0];
    if (operation === undefined || operation.kind !== 'send_message')
      throw new ProductServiceError(
        'INVALID_INPUT',
        'Proposal operation is invalid.',
      );
    const approvedAt = this.now();
    const connectorSnapshot = connectorSnapshotSchema.parse({
      connectorId: 'gmail',
      descriptorVersion: '1',
      accountId: ACCOUNT_ID,
      capabilitySnapshotHash: sha256('public-gmail-effect-disabled'),
      runtimeMode: 'fixture' as const,
      selectionState: 'selected' as const,
    });
    const binding: OperationApprovalBinding = {
      operationId: operation.operationId,
      attemptId: attemptIdSchema.parse(
        id('attempt', { operationId: operation.operationId }),
      ),
      account: {
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        expectedStateVersion: 1,
      },
      connectorSnapshot,
      renderedPayloadFingerprint: operation.renderedPayloadFingerprint,
      draftRevisionId: operation.draftRevisionId,
      clientCorrelation: {
        kind: 'client_reference',
        value: operation.operationId,
      },
      correlationBindingVersion: '1',
      reconciliationStrategy: 'effect-disabled-terminal',
      reconciliationStrategyVersion: '1',
      contactPolicies: [
        {
          tenantId: TENANT_ID,
          contactIdentityDigest: operation.recipientDigests[0] as never,
          channel: 'email',
          connectorAccountId: ACCOUNT_ID,
          brandId: BRAND_ID,
          projectionVersion: 1,
        },
      ],
      effectSwitch: {
        globalVersion: 1,
        accountVersion: 1,
        operationVersion: 1,
        policy: 'effect_disabled',
      },
    };
    const bundle = buildImmutableApprovalBundle({
      actor: context.actor,
      actionPlan: proposal.actionPlan,
      approvalId: id('approval', { proposalId: proposal.proposalId }),
      executionIntentId: id('intent', { proposalId: proposal.proposalId }),
      approvedAt,
      bindings: [binding],
    });
    const immutableOperation = bundle.operations[0];
    if (immutableOperation === undefined)
      throw new Error('APPROVAL_OPERATION_NOT_CREATED');
    const state: AuthoritativeExecutionState = {
      actionPlan: bundle.actionPlan,
      approval: bundle.approval,
      operation: immutableOperation,
      currentSourceMessageRevisionId: bundle.actionPlan.sourceMessageRevisionId,
      approverAuthorityActive: true,
      connector: {
        accountId: ACCOUNT_ID,
        stateVersion: 1,
        status: 'active',
        health: 'healthy',
        snapshot: connectorSnapshot,
        operationCapabilityEnabled: true,
      },
      contactPolicies: [
        {
          schemaVersion: '1',
          tenantId: TENANT_ID,
          contactIdentityDigest: operation.recipientDigests[0] as never,
          channel: 'email',
          connectorAccountId: ACCOUNT_ID,
          brandId: BRAND_ID,
          state: 'allowed',
          applicableFactIds: [],
          reducerVersion: '1',
          projectionVersion: 1,
          updatedAt: approvedAt,
        },
      ],
      effectSwitch: {
        ...binding.effectSwitch,
        globalEnabled: false,
        accountEnabled: false,
        operationEnabled: false,
      },
    };
    const receipt = {
      kind: 'effect_disabled' as const,
      operationId: operation.operationId,
      artifactHash: immutableOperation.artifactHash,
      stableIdempotencyKey: immutableOperation.artifact.stableIdempotencyKey,
      observedAt: approvedAt,
    };
    const built = buildDynamoApprovalExecutionRecords({
      state,
      createdAt: approvedAt,
    });
    const execution: DynamoApprovalExecutionRecords = {
      ...built,
      aggregate: {
        ...built.aggregate,
        executionStatus: 'settled',
        executionOutcome: 'effect_disabled',
        attemptCount: 1,
        stateVersion: 2,
        effectDisabledReceipt: receipt,
        settledAt: approvedAt,
      } as unknown as DynamoApprovalExecutionRecords['aggregate'],
    };
    const approved: StoredProposal = {
      ...proposal,
      status: 'approved',
      updatedAt: approvedAt,
      approvalId: bundle.approval.approvalId,
      operationId: operation.operationId,
      receipt,
      approvedFromUpdatedAt: proposal.updatedAt,
    };
    try {
      await this.repository.approveAtomically(TENANT_ID, {
        proposal: {
          entityType: 'proposal',
          entityId: proposal.proposalId,
          revisionId: `${proposal.proposalId}:approved:${bundle.approval.approvalId}`,
          version: current.version + 1,
          expectedVersion: current.version,
          expectedRevisionId: current.revisionId,
          committedAt: approvedAt,
          value: approved,
        },
        execution,
      });
    } catch (error) {
      if (!(error instanceof PersistenceConflictError)) throw error;
    }
    const reloaded = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (
      reloaded?.value.status !== 'approved' ||
      reloaded.value.approvedFromUpdatedAt !== input.expectedProposalUpdatedAt
    )
      throw new ProductServiceError(
        'STALE_REVISION',
        'Approval transaction conflicted.',
      );
    const result = this.#approvalResult(reloaded.value);
    await this.operationQueue?.enqueue(result.operationId);
    return result;
  }

  #approvalResult(proposal: StoredProposal): ApproveProposalResult {
    if (
      proposal.status !== 'approved' ||
      proposal.approvalId === undefined ||
      proposal.operationId === undefined ||
      proposal.receipt === undefined
    )
      throw new Error('MALFORMED_APPROVED_PROPOSAL');
    return approveProposalResultSchema.parse({
      proposalId: proposal.proposalId,
      actionPlanId: proposal.actionPlan.actionPlanId,
      actionPlanRevision: proposal.actionPlan.revision,
      actionPlanHash: proposal.actionPlan.canonicalHash,
      approvalId: proposal.approvalId,
      operationId: proposal.operationId,
      status: 'approved',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      receipt: proposal.receipt,
      updatedAt: proposal.updatedAt,
    });
  }

  public async getApprovalStatus(
    context: ProductRequestContext,
    input: { readonly proposalId: string },
  ) {
    this.#assertContext(context);
    const current = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (current === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    return getApprovalStatusResultSchema.parse({
      proposalId: current.value.proposalId,
      status: current.value.status,
      approvalUrl: current.value.approvalUrl,
      updatedAt: current.value.updatedAt,
    });
  }

  public async getExecutionStatus(
    context: ProductRequestContext,
    input: { readonly proposalId: string },
  ): Promise<ExecutionStatusResult> {
    this.#assertContext(context);
    const current = await this.repository.getCurrent<StoredProposal>(
      TENANT_ID,
      'proposal',
      input.proposalId,
    );
    if (current === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    return executionStatusResultSchema.parse({
      proposalId: input.proposalId,
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status:
        current.value.status === 'approved'
          ? 'effect_disabled'
          : 'pending_approval',
      ...(current.value.receipt === undefined
        ? {}
        : { receipt: current.value.receipt }),
    });
  }
}

export const durableEvaluatorAuthority = Object.freeze({
  tenantId: TENANT_ID,
  userId: USER_ID,
  accountId: ACCOUNT_ID,
  brandId: BRAND_ID,
});

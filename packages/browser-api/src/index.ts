import { createApiClient } from '@chief/api-client';
import {
  createDraftResultSchema,
  getApprovalStatusResultSchema,
  getCommunicationResultSchema,
  getConnectorStatusResultSchema,
  getRelatedAsanaWorkResultSchema,
  getSlaMetricsResultSchema,
  getThreadContextResultSchema,
  healthResponseSchema,
  listCommunicationsResultSchema,
  prepareAsanaActionResultSchema,
  recommendActionResultSchema,
  requestContextResultSchema,
  reviseDraftResultSchema,
  searchKnowledgeResultSchema,
  submitApprovalResultSchema,
  type ActionRecommendation,
  type CitedDraftResult,
  type CommunicationDetailView,
  type CommunicationSummaryView,
  type ConnectorStatusView,
  type ContextRequest,
  type HealthResponse,
  type ProposalHandoff,
  type RetrievalCandidate,
  type Citation,
  type SlaSnapshot,
  type ThreadContextView,
  type WorkObjectFact,
} from '@chief/contracts';

export interface CommunicationListInput {
  readonly status?: 'pending' | 'answered' | 'overdue' | 'resolved';
  readonly limit: number;
  readonly cursor?: string;
}

export interface ThreadInput {
  readonly threadId: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface SearchKnowledgeInput {
  readonly queryText: string;
  readonly exactEntityRefs: string[];
  readonly limit: number;
}

export interface BrowserDashboardMetrics {
  readonly snapshot: SlaSnapshot;
  readonly totalCommunications: number;
  readonly pendingApprovalCount: number;
  readonly channelBreakdown: readonly {
    readonly channel: string;
    readonly count: number;
  }[];
}

export interface BrowserExecutionStatus {
  readonly proposalId: string;
  readonly runtimeMode: 'fixture';
  readonly effectPolicy: 'effect_disabled';
  readonly externalEffect: false;
  readonly status: 'not_requested' | 'pending_approval' | 'effect_disabled';
  readonly receipt?: {
    readonly kind: 'effect_disabled';
    readonly operationId: string;
    readonly artifactHash: string;
    readonly stableIdempotencyKey: string;
    readonly observedAt: string;
  };
}

export interface BrowserApprovalStatus {
  readonly proposalId: string;
  readonly status:
    | 'prepared'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  readonly approvalUrl?: string;
  readonly updatedAt: string;
}

export interface BrowserApi {
  systemHealth(): Promise<HealthResponse>;
  dashboardMetrics(
    window: '24h' | '7d' | '30d',
  ): Promise<BrowserDashboardMetrics>;
  slaMetrics(window: '24h' | '7d' | '30d'): Promise<SlaSnapshot>;
  listCommunications(input: CommunicationListInput): Promise<{
    readonly items: CommunicationSummaryView[];
    readonly nextCursor?: string;
  }>;
  getCommunication(messageRevisionId: string): Promise<CommunicationDetailView>;
  getThread(input: ThreadInput): Promise<ThreadContextView>;
  getConnectorStatus(connectorId?: string): Promise<ConnectorStatusView[]>;
  getRelatedAsanaWork(
    messageRevisionId: string,
    limit: number,
  ): Promise<WorkObjectFact[]>;
  searchKnowledge(input: SearchKnowledgeInput): Promise<{
    readonly candidates: RetrievalCandidate[];
    readonly citations: Citation[];
  }>;
  recommendAction(
    messageRevisionId: string,
    expectedMessageRevision: number,
  ): Promise<ActionRecommendation>;
  createDraft(
    recommendationId: string,
    expectedRecommendationRevision: number,
  ): Promise<CitedDraftResult>;
  reviseDraft(input: {
    readonly draftRevisionId: string;
    readonly expectedDraftRevision: number;
    readonly revisionInstruction: string;
  }): Promise<CitedDraftResult>;
  requestContext(input: {
    readonly recommendationId: string;
    readonly expectedRecommendationRevision: number;
    readonly focusedQuestion?: string;
  }): Promise<ContextRequest>;
  prepareApproval(input: {
    readonly actionPlanId: string;
    readonly expectedActionPlanRevision: number;
    readonly actionPlanHash: string;
  }): Promise<ProposalHandoff>;
  prepareAsanaAction(
    recommendationId: string,
    expectedRecommendationRevision: number,
  ): Promise<ProposalHandoff>;
  getApprovalStatus(proposalId: string): Promise<BrowserApprovalStatus>;
  getExecutionStatus(proposalId: string): Promise<BrowserExecutionStatus>;
}

export function createBrowserApi(baseUrl: string): BrowserApi {
  const client = createApiClient({ baseUrl });

  return {
    async systemHealth() {
      return healthResponseSchema.parse(await client.system.health.query());
    },
    async dashboardMetrics(window) {
      return client.dashboard.metrics.query({ window });
    },
    async slaMetrics(window) {
      return getSlaMetricsResultSchema.parse(
        await client.dashboard.sla.query({ window }),
      ).snapshot;
    },
    async listCommunications(input) {
      return listCommunicationsResultSchema.parse(
        await client.communications.list.query(input),
      );
    },
    async getCommunication(messageRevisionId) {
      return getCommunicationResultSchema.parse(
        await client.communications.get.query({ messageRevisionId }),
      ).communication;
    },
    async getThread(input) {
      return getThreadContextResultSchema.parse(
        await client.communications.thread.query(input),
      ).thread;
    },
    async getConnectorStatus(connectorId) {
      const input = connectorId === undefined ? {} : { connectorId };
      return getConnectorStatusResultSchema.parse(
        await client.connectors.status.query(input),
      ).connectors;
    },
    async getRelatedAsanaWork(messageRevisionId, limit) {
      return getRelatedAsanaWorkResultSchema.parse(
        await client.work.relatedAsana.query({ messageRevisionId, limit }),
      ).items;
    },
    async searchKnowledge(input) {
      return searchKnowledgeResultSchema.parse(
        await client.knowledge.search.query(input),
      );
    },
    async recommendAction(messageRevisionId, expectedMessageRevision) {
      return recommendActionResultSchema.parse(
        await client.agent.recommend.mutate({
          messageRevisionId,
          expectedMessageRevision,
        }),
      ).recommendation;
    },
    async createDraft(recommendationId, expectedRecommendationRevision) {
      return createDraftResultSchema.parse(
        await client.agent.createDraft.mutate({
          recommendationId,
          expectedRecommendationRevision,
        }),
      ).result;
    },
    async reviseDraft(input) {
      return reviseDraftResultSchema.parse(
        await client.agent.reviseDraft.mutate(input),
      ).result;
    },
    async requestContext(input) {
      return requestContextResultSchema.parse(
        await client.agent.requestContext.mutate(input),
      ).request;
    },
    async prepareApproval(input) {
      return submitApprovalResultSchema.parse(
        await client.approvals.prepare.mutate(input),
      );
    },
    async prepareAsanaAction(recommendationId, expectedRecommendationRevision) {
      return prepareAsanaActionResultSchema.parse(
        await client.approvals.prepareAsana.mutate({
          recommendationId,
          expectedRecommendationRevision,
        }),
      );
    },
    async getApprovalStatus(proposalId) {
      return getApprovalStatusResultSchema.parse(
        await client.approvals.status.query({ proposalId }),
      );
    },
    async getExecutionStatus(proposalId) {
      return client.execution.status.query({ proposalId });
    },
  };
}

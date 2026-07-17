import { createHash } from 'node:crypto';

import type { McpToolName } from '@chief/contracts';
import {
  actionRecommendationSchema,
  citedDraftResultSchema,
  communicationDetailViewSchema,
  communicationSummaryViewSchema,
  connectorStatusViewSchema,
  contextRequestSchema,
  createDraftInputSchema,
  getApprovalStatusInputSchema,
  getApprovalStatusResultSchema,
  getCommunicationInputSchema,
  getConnectorStatusInputSchema,
  getRelatedAsanaWorkInputSchema,
  getSlaMetricsInputSchema,
  getThreadContextInputSchema,
  listCommunicationsInputSchema,
  prepareAsanaActionInputSchema,
  proposalHandoffSchema,
  recommendActionInputSchema,
  requestContextInputSchema,
  reviseDraftInputSchema,
  searchKnowledgeInputSchema,
  submitApprovalInputSchema,
  workObjectFactSchema,
  type ActionRecommendation,
  type CitedDraftResult,
  type CommunicationDetailView,
  type CommunicationSummaryView,
  type ConnectorStatusView,
  type ProposalHandoff,
} from '@chief/contracts';

import type { McpRequestScope, McpToolService } from './service.js';
import { McpToolError } from './service.js';

const FIXTURE_NOW = '2026-07-17T12:00:00.000Z';
const FIXTURE_TENANT_ID = 'tenant_public_assessment';
const FIXTURE_USER_ID = 'user_public_evaluator';
const FIXTURE_AUTHORIZATION_EPOCH = 1;
const FIXTURE_PROFILE_HASH = sha256('fixture-generation-profile');
const FIXTURE_SNAPSHOT_HASH = sha256('fixture-retrieval-snapshot');
const FIXTURE_ACTION_PLAN_ID = 'action_plan_fixture_reply';
const FIXTURE_ACTION_PLAN_HASH = sha256('action-plan-fixture-reply-v1');
const FIXTURE_EFFECT_DISABLED_PROPOSAL_ID = 'proposal_fixture_effect_disabled';
const FIXTURE_APPROVAL_PROPOSAL_ID = 'proposal-fixture-reply-v1';
const THREAD_CHANNELS: Readonly<Record<string, 'email' | 'sms'>> =
  Object.freeze({
    'thread-1': 'email',
    'thread-2': 'email',
    'thread-3': 'sms',
    'thread-4': 'email',
  });

export function configuredProductBaseUrl(
  value = process.env.CHIEF_PRODUCT_BASE_URL ?? 'https://chief.example.test',
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'CHIEF_PRODUCT_BASE_URL must be a credential-free HTTPS origin.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error(
      'CHIEF_PRODUCT_BASE_URL must be a credential-free HTTPS origin.',
    );
  }
  return url.origin;
}

const PRODUCT_BASE_URL = configuredProductBaseUrl();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyedDigest(value: string): string {
  return `h1_v1_${createHash('sha256').update(value).digest('base64url')}`;
}

function productUrl(path: string): string {
  return `${PRODUCT_BASE_URL}${path}`;
}

function citation(label: string, index: number) {
  return {
    citationId: `citation-${index}`,
    sourceId: `source-${index}`,
    sourceVersion: '1',
    chunkId: `chunk-${index}`,
    label,
    contentHash: sha256(`citation-${index}`),
    hydratedUnderAuthorizationEpoch: FIXTURE_AUTHORIZATION_EPOCH,
  };
}

function reproducibility(routeId: string) {
  return {
    schemaVersion: '1' as const,
    selectedProfileManifestHash: FIXTURE_PROFILE_HASH,
    routeId,
    modelProfileId: 'fixture-deterministic-no-model',
    gatewayVersion: '1',
    promptHash: sha256(`prompt-${routeId}`),
    policyHash: sha256('public-effect-disabled-policy'),
    schemaHash: sha256(`schema-${routeId}`),
    retrievalQueryHash: sha256(`query-${routeId}`),
    retrievalSnapshotManifestHash: FIXTURE_SNAPSHOT_HASH,
    requestHash: sha256(`request-${routeId}`),
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 1,
    outcome: 'degraded' as const,
  };
}

function makeSummary(input: {
  readonly index: number;
  readonly thread: number;
  readonly status: 'pending' | 'answered' | 'overdue' | 'resolved';
  readonly sender: string;
  readonly subject: string;
  readonly excerpt: string;
  readonly timestamp: string;
  readonly attachments?: number;
  readonly direction?: 'inbound' | 'outbound';
}): CommunicationSummaryView {
  return communicationSummaryViewSchema.parse({
    messageId: `message-${input.index}`,
    messageRevisionId: `message-revision-${input.index}-1`,
    revision: 1,
    threadId: `thread-${input.thread}`,
    direction: input.direction ?? 'inbound',
    status: input.status,
    senderDisplayName: input.sender,
    recipientDisplayNames: ['Avery Morgan'],
    subject: input.subject,
    excerpt: input.excerpt,
    attachmentCount: input.attachments ?? 0,
    sourceTimestamp: input.timestamp,
    productUrl: productUrl(`/communications/message-revision-${input.index}-1`),
  });
}

function communicationFixtures() {
  const summaries = [
    makeSummary({
      index: 1,
      thread: 1,
      status: 'overdue',
      sender: 'Jordan Lee',
      subject: 'Friday launch decision',
      excerpt: 'Can we confirm the Friday launch and the owner for QA?',
      timestamp: '2026-07-17T10:52:00.000Z',
      attachments: 1,
    }),
    makeSummary({
      index: 2,
      thread: 2,
      status: 'pending',
      sender: 'Priya Shah',
      subject: 'Board update numbers',
      excerpt: 'Please send the approved pipeline numbers for the board note.',
      timestamp: '2026-07-17T11:06:00.000Z',
    }),
    makeSummary({
      index: 3,
      thread: 3,
      status: 'pending',
      sender: 'Mateo Ruiz',
      subject: 'Customer escalation',
      excerpt: 'The customer needs an owner and next update time today.',
      timestamp: '2026-07-17T11:21:00.000Z',
    }),
    makeSummary({
      index: 4,
      thread: 1,
      status: 'answered',
      sender: 'Avery Morgan',
      subject: 'Re: Friday launch decision',
      excerpt: 'I am checking the QA dependency and will confirm shortly.',
      timestamp: '2026-07-17T11:28:00.000Z',
      direction: 'outbound',
    }),
    makeSummary({
      index: 5,
      thread: 4,
      status: 'resolved',
      sender: 'System Notifications',
      subject: 'Weekly digest',
      excerpt: 'Your weekly activity digest is ready.',
      timestamp: '2026-07-17T09:00:00.000Z',
    }),
  ];
  const details = new Map<string, CommunicationDetailView>();
  for (const summary of summaries) {
    const itemCitation = citation(
      `${summary.subject ?? 'Communication'} · ${summary.sourceTimestamp}`,
      summary.revision,
    );
    details.set(
      summary.messageRevisionId,
      communicationDetailViewSchema.parse({
        ...summary,
        authoredText: summary.excerpt,
        normalizedText: summary.excerpt,
        attachments:
          summary.attachmentCount === 0
            ? []
            : [
                {
                  attachmentId: `attachment-${summary.messageId}`,
                  fileName: 'launch-readiness.pdf',
                  mediaType: 'application/pdf',
                  byteLength: 24_576,
                  malwareState: 'clean',
                  productUrl: productUrl(
                    `/attachments/attachment-${summary.messageId}`,
                  ),
                },
              ],
        citations: [itemCitation],
      }),
    );
  }
  return { summaries: Object.freeze(summaries), details };
}

function connectorFixtures(): readonly ConnectorStatusView[] {
  const communicationCapabilities = {
    read: true,
    send: false,
    webhook: false,
    poll: true,
    threads: true,
    attachments: true,
    deliveryFeedback: false,
    multipleAccounts: true,
    historicalBackfill: true,
    externalEffect: false,
    replyCorrelation: true,
    complaintFeedback: false,
    unsubscribeFeedback: false,
    optOutFeedback: false,
    reconsentFeedback: false,
    consentWindowEligibility: false,
  };
  return Object.freeze([
    connectorStatusViewSchema.parse({
      accountId: 'account-gmail-fixture',
      brandId: 'brand-executive',
      connectorId: 'gmail',
      displayLabel: 'Executive Gmail fixture',
      provider: 'gmail',
      connectorKind: 'communication',
      channel: 'email',
      status: 'active',
      health: 'healthy',
      runtimeMode: 'fixture',
      selectionState: 'selected',
      capabilities: communicationCapabilities,
      lastSyncAt: FIXTURE_NOW,
      productUrl: productUrl('/settings/connectors/gmail'),
    }),
    connectorStatusViewSchema.parse({
      accountId: 'account-twilio-fixture',
      brandId: 'brand-executive',
      connectorId: 'twilio-sms',
      displayLabel: 'SMS fixture',
      provider: 'twilio',
      connectorKind: 'communication',
      channel: 'sms',
      status: 'active',
      health: 'healthy',
      runtimeMode: 'fixture',
      selectionState: 'selected',
      capabilities: {
        ...communicationCapabilities,
        attachments: false,
        historicalBackfill: false,
        threads: false,
      },
      lastSyncAt: FIXTURE_NOW,
      productUrl: productUrl('/settings/connectors/twilio-sms'),
    }),
    connectorStatusViewSchema.parse({
      accountId: 'account-graph-candidate',
      brandId: 'brand-executive',
      connectorId: 'microsoft-graph',
      displayLabel: 'Microsoft Graph candidate',
      provider: 'microsoft-graph',
      connectorKind: 'communication',
      channel: 'email',
      status: 'disabled',
      health: 'unknown',
      runtimeMode: 'disabled',
      selectionState: 'unselected_candidate',
      capabilities: { ...communicationCapabilities, read: false, poll: false },
      productUrl: productUrl('/settings/connectors/microsoft-graph'),
    }),
    connectorStatusViewSchema.parse({
      accountId: 'account-asana-fixture',
      brandId: 'brand-executive',
      connectorId: 'asana',
      displayLabel: 'Executive Asana fixture',
      provider: 'asana',
      connectorKind: 'work_management',
      status: 'active',
      health: 'healthy',
      runtimeMode: 'fixture',
      selectionState: 'selected',
      capabilities: {
        readTasks: true,
        readProjects: true,
        readMilestones: true,
        readComments: true,
        createTask: false,
        updateTask: false,
        createComment: false,
        webhooks: false,
        attachments: true,
        multipleAccounts: true,
        externalEffect: false,
      },
      lastSyncAt: FIXTURE_NOW,
      productUrl: productUrl('/settings/connectors/asana'),
    }),
  ]);
}

function recommendationFixtures(): ReadonlyMap<string, ActionRecommendation> {
  const values = [
    actionRecommendationSchema.parse({
      schemaVersion: '1',
      tenantId: FIXTURE_TENANT_ID,
      recommendationId: 'recommendation-1',
      revision: 1,
      sourceMessageRevisionId: 'message-revision-1-1',
      actionType: 'reply',
      structuredParameters: { requestedCommitment: 'Friday launch' },
      confidence: 0.87,
      urgency: 'high',
      reasonSummary:
        'The sender asks for a launch commitment and a named QA owner.',
      citations: [citation('Launch readiness task · due Friday', 11)],
      missingFacts: [],
      status: 'current',
      reproducibility: reproducibility('fixture-action-context'),
      createdAt: FIXTURE_NOW,
    }),
    actionRecommendationSchema.parse({
      schemaVersion: '1',
      tenantId: FIXTURE_TENANT_ID,
      recommendationId: 'recommendation-2',
      revision: 1,
      sourceMessageRevisionId: 'message-revision-2-1',
      actionType: 'request_context',
      structuredParameters: {},
      confidence: 0.54,
      urgency: 'normal',
      reasonSummary: 'The latest approved board metrics are not in evidence.',
      citations: [citation('Board update workstream · metrics pending', 12)],
      missingFacts: ['approved pipeline metric set'],
      status: 'needs_context',
      reproducibility: reproducibility('fixture-action-context'),
      createdAt: FIXTURE_NOW,
    }),
    actionRecommendationSchema.parse({
      schemaVersion: '1',
      tenantId: FIXTURE_TENANT_ID,
      recommendationId: 'recommendation-3',
      revision: 1,
      sourceMessageRevisionId: 'message-revision-3-1',
      actionType: 'create_asana_task',
      structuredParameters: { project: 'Customer Operations' },
      confidence: 0.91,
      urgency: 'critical',
      reasonSummary: 'The escalation needs a durable owner and update time.',
      citations: [citation('Customer escalation policy', 13)],
      missingFacts: [],
      status: 'current',
      reproducibility: reproducibility('fixture-action-context'),
      createdAt: FIXTURE_NOW,
    }),
    actionRecommendationSchema.parse({
      schemaVersion: '1',
      tenantId: FIXTURE_TENANT_ID,
      recommendationId: 'recommendation-5',
      revision: 1,
      sourceMessageRevisionId: 'message-revision-5-1',
      actionType: 'ignore_system',
      structuredParameters: { reason: 'automated_digest' },
      confidence: 0.99,
      urgency: 'low',
      reasonSummary:
        'The communication is an automated weekly digest with no requested action.',
      citations: [citation('Weekly digest classification evidence', 15)],
      missingFacts: [],
      status: 'current',
      reproducibility: reproducibility('fixture-action-context'),
      createdAt: FIXTURE_NOW,
    }),
  ];
  return new Map(values.map((value) => [value.sourceMessageRevisionId, value]));
}

function draftFor(
  recommendation: ActionRecommendation,
  revision: number,
  body: string,
  supersedesRevisionId?: string,
): CitedDraftResult {
  const draftId = `draft-${recommendation.recommendationId}`;
  const draftRevisionId = `${draftId}-revision-${revision}`;
  return citedDraftResultSchema.parse({
    draft: {
      schemaVersion: '1',
      tenantId: FIXTURE_TENANT_ID,
      draftId,
      draftRevisionId,
      revision,
      connectorAccountId: 'account-gmail-fixture',
      sourceMessageRevisionId: recommendation.sourceMessageRevisionId,
      recipientDigests: [
        keyedDigest(`recipient-${recommendation.recommendationId}`),
      ],
      subject: 'Re: Executive communication',
      body,
      attachmentContentHashes: [],
      citations: recommendation.citations,
      styleProfileVersion: 'fixture-style-v1',
      rendererId: 'fixture-email-renderer',
      rendererVersion: '1',
      renderedPayloadFingerprint: sha256(`rendered:${draftRevisionId}:${body}`),
      contentHash: sha256(`content:${draftRevisionId}:${body}`),
      createdBy: revision === 1 ? 'agent' : 'user',
      ...(supersedesRevisionId === undefined ? {} : { supersedesRevisionId }),
      reproducibility: reproducibility('fixture-draft'),
      createdAt: FIXTURE_NOW,
    },
    factualCitationCount: recommendation.citations.length,
    unresolvedFacts: recommendation.missingFacts,
    validation:
      recommendation.missingFacts.length === 0 ? 'passed' : 'needs_context',
  });
}

function decodeCursor(cursor: string | undefined, status: string | undefined) {
  if (cursor === undefined) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [version, offsetValue, cursorStatus] = decoded.split(':');
    const offset = Number(offsetValue);
    if (
      version !== 'fixture-v1' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      cursorStatus !== (status ?? '*')
    ) {
      throw new Error('invalid');
    }
    return offset;
  } catch {
    throw new McpToolError('INVALID_CURSOR');
  }
}

function encodeCursor(offset: number, status: string | undefined): string {
  return Buffer.from(`fixture-v1:${offset}:${status ?? '*'}`, 'utf8').toString(
    'base64url',
  );
}

function assertScope(scope: McpRequestScope): void {
  if (
    scope.kind !== 'public_fixture' ||
    scope.tenantId !== FIXTURE_TENANT_ID ||
    scope.userId !== FIXTURE_USER_ID ||
    scope.authorizationEpoch !== FIXTURE_AUTHORIZATION_EPOCH
  ) {
    throw new McpToolError('NOT_FOUND');
  }
}

interface ProposalState {
  readonly handoff: ProposalHandoff;
  readonly status:
    | 'prepared'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  readonly updatedAt: string;
}

export const publicFixtureIdentifiers = Object.freeze({
  tenantId: FIXTURE_TENANT_ID,
  userId: FIXTURE_USER_ID,
  firstMessageRevisionId: 'message-revision-1-1',
  smsMessageRevisionId: 'message-revision-3-1',
  recommendationId: 'recommendation-1',
  actionPlanId: FIXTURE_ACTION_PLAN_ID,
  actionPlanRevision: 1,
  actionPlanHash: FIXTURE_ACTION_PLAN_HASH,
  approvalProposalId: FIXTURE_APPROVAL_PROPOSAL_ID,
  asanaProposalId: 'proposal-asana-recommendation-1',
  effectDisabledProposalId: FIXTURE_EFFECT_DISABLED_PROPOSAL_ID,
});

export class FixtureMcpToolService implements McpToolService {
  readonly #summaries: readonly CommunicationSummaryView[];
  readonly #details: ReadonlyMap<string, CommunicationDetailView>;
  readonly #connectors: readonly ConnectorStatusView[];
  readonly #recommendationsByMessage: ReadonlyMap<string, ActionRecommendation>;
  readonly #recommendationsById: ReadonlyMap<string, ActionRecommendation>;
  readonly #drafts = new Map<string, CitedDraftResult>();
  readonly #currentDraftByDraftId = new Map<string, string>();
  readonly #proposals = new Map<string, ProposalState>();

  public constructor() {
    const communications = communicationFixtures();
    this.#summaries = communications.summaries;
    this.#details = communications.details;
    this.#connectors = connectorFixtures();
    this.#recommendationsByMessage = recommendationFixtures();
    this.#recommendationsById = new Map(
      [...this.#recommendationsByMessage.values()].map((value) => [
        value.recommendationId,
        value,
      ]),
    );
    const effectDisabledHandoff = proposalHandoffSchema.parse({
      proposalId: FIXTURE_EFFECT_DISABLED_PROPOSAL_ID,
      approvalUrl: productUrl(
        `/approvals/${FIXTURE_EFFECT_DISABLED_PROPOSAL_ID}`,
      ),
      status: 'pending_approval',
      directEffectAvailable: false,
    });
    this.#proposals.set(FIXTURE_EFFECT_DISABLED_PROPOSAL_ID, {
      handoff: effectDisabledHandoff,
      status: 'approved',
      updatedAt: FIXTURE_NOW,
    });
  }

  public call(
    toolName: McpToolName,
    rawInput: unknown,
    scope: McpRequestScope,
  ): unknown {
    assertScope(scope);
    switch (toolName) {
      case 'list_pending_communications': {
        const input = listCommunicationsInputSchema.parse(rawInput);
        const filtered =
          input.status === undefined
            ? this.#summaries
            : this.#summaries.filter(({ status }) => status === input.status);
        const offset = decodeCursor(input.cursor, input.status);
        if (offset > filtered.length) throw new McpToolError('INVALID_CURSOR');
        const items = filtered.slice(offset, offset + input.limit);
        const nextOffset = offset + items.length;
        return {
          items,
          ...(nextOffset < filtered.length
            ? { nextCursor: encodeCursor(nextOffset, input.status) }
            : {}),
        };
      }
      case 'get_communication': {
        const input = getCommunicationInputSchema.parse(rawInput);
        const communication = this.#details.get(input.messageRevisionId);
        if (!communication) throw new McpToolError('NOT_FOUND');
        return { communication };
      }
      case 'get_thread_context': {
        const input = getThreadContextInputSchema.parse(rawInput);
        const inThread = this.#summaries.filter(
          ({ threadId }) => threadId === input.threadId,
        );
        if (inThread.length === 0) throw new McpToolError('NOT_FOUND');
        const offset = decodeCursor(input.cursor, input.threadId);
        if (offset > inThread.length) throw new McpToolError('INVALID_CURSOR');
        const communications = inThread.slice(offset, offset + input.limit);
        const nextOffset = offset + communications.length;
        const latest = inThread.at(-1);
        const channel = THREAD_CHANNELS[input.threadId];
        if (!latest || !channel) throw new McpToolError('NOT_FOUND');
        const participantDisplayNames = [
          ...new Set(
            inThread.flatMap((communication) => [
              ...(communication.senderDisplayName === undefined
                ? []
                : [communication.senderDisplayName]),
              ...communication.recipientDisplayNames,
            ]),
          ),
        ];
        return {
          thread: {
            threadId: input.threadId,
            channel,
            subject: inThread[0]?.subject,
            participantDisplayNames,
            status: 'active',
            latestMessageRevisionId: latest.messageRevisionId,
            sourceUpdatedAt: latest.sourceTimestamp,
            communications,
            ...(nextOffset < inThread.length
              ? { nextCursor: encodeCursor(nextOffset, input.threadId) }
              : {}),
            productUrl: productUrl(`/threads/${input.threadId}`),
          },
        };
      }
      case 'search_knowledge': {
        const input = searchKnowledgeInputSchema.parse(rawInput);
        const query = input.queryText.trim().toLocaleLowerCase('en-US');
        if (query.length === 0) throw new McpToolError('NOT_FOUND');
        const candidates = this.#summaries
          .filter((item) =>
            `${item.subject ?? ''} ${item.excerpt}`
              .toLocaleLowerCase('en-US')
              .includes(query.split(/\s+/u)[0] ?? query),
          )
          .slice(0, input.limit)
          .map((item, index) => ({
            chunkId: `chunk-search-${index}`,
            sourceId: `source-search-${item.messageId}`,
            lexicalScore: 1 - index * 0.1,
            vectorScore: 0.8 - index * 0.1,
            fusedScore: 0.9 - index * 0.1,
            authorizationEpoch: scope.authorizationEpoch,
          }));
        const citations = candidates.map((candidate, index) => ({
          ...citation(
            `Authorized communication result ${index + 1}`,
            index + 20,
          ),
          chunkId: candidate.chunkId,
          sourceId: candidate.sourceId,
        }));
        return { candidates, citations };
      }
      case 'get_related_asana_work': {
        const input = getRelatedAsanaWorkInputSchema.parse(rawInput);
        if (!this.#details.has(input.messageRevisionId)) {
          throw new McpToolError('NOT_FOUND');
        }
        return {
          items: [
            workObjectFactSchema.parse({
              kind: 'task',
              providerObjectId: 'asana-task-launch-readiness',
              providerVersion: '2026-07-17T11:42:00.000Z',
              providerTimestamp: '2026-07-17T11:42:00.000Z',
              payloadFingerprint: sha256('asana-task-launch-readiness'),
            }),
            workObjectFactSchema.parse({
              kind: 'project',
              providerObjectId: 'asana-project-customer-operations',
              providerVersion: '2026-07-17T09:00:00.000Z',
              providerTimestamp: '2026-07-17T09:00:00.000Z',
              payloadFingerprint: sha256('asana-project-customer-operations'),
            }),
          ].slice(0, input.limit),
        };
      }
      case 'recommend_action': {
        const input = recommendActionInputSchema.parse(rawInput);
        const communication = this.#details.get(input.messageRevisionId);
        if (!communication) throw new McpToolError('NOT_FOUND');
        if (communication.revision !== input.expectedMessageRevision) {
          throw new McpToolError('STALE_REVISION');
        }
        const recommendation = this.#recommendationsByMessage.get(
          input.messageRevisionId,
        );
        if (!recommendation) throw new McpToolError('NOT_FOUND');
        return { recommendation };
      }
      case 'create_draft': {
        const input = createDraftInputSchema.parse(rawInput);
        const recommendation = this.#recommendationsById.get(
          input.recommendationId,
        );
        if (!recommendation) throw new McpToolError('NOT_FOUND');
        if (recommendation.revision !== input.expectedRecommendationRevision) {
          throw new McpToolError('STALE_REVISION');
        }
        const draftId = `draft-${recommendation.recommendationId}`;
        const currentRevisionId = this.#currentDraftByDraftId.get(draftId);
        const existing =
          currentRevisionId === undefined
            ? undefined
            : this.#drafts.get(currentRevisionId);
        if (existing) return { result: existing };
        const result = draftFor(
          recommendation,
          1,
          recommendation.actionType === 'request_context'
            ? 'I am confirming the approved figures and will follow up with a sourced update.'
            : 'Thanks for the note. QA ownership is confirmed, and I will send the final launch update today.',
        );
        this.#drafts.set(result.draft.draftRevisionId, result);
        this.#currentDraftByDraftId.set(
          result.draft.draftId,
          result.draft.draftRevisionId,
        );
        return { result };
      }
      case 'revise_draft': {
        const input = reviseDraftInputSchema.parse(rawInput);
        const current = this.#drafts.get(input.draftRevisionId);
        if (!current) throw new McpToolError('NOT_FOUND');
        if (
          current.draft.revision !== input.expectedDraftRevision ||
          this.#currentDraftByDraftId.get(current.draft.draftId) !==
            current.draft.draftRevisionId
        ) {
          throw new McpToolError('STALE_REVISION');
        }
        const recommendation = this.#recommendationsByMessage.get(
          current.draft.sourceMessageRevisionId,
        );
        if (!recommendation) throw new McpToolError('NOT_FOUND');
        const result = draftFor(
          recommendation,
          current.draft.revision + 1,
          `${current.draft.body}\n\nRevision note: ${input.revisionInstruction}`,
          current.draft.draftRevisionId,
        );
        this.#drafts.set(result.draft.draftRevisionId, result);
        this.#currentDraftByDraftId.set(
          result.draft.draftId,
          result.draft.draftRevisionId,
        );
        return { result };
      }
      case 'request_context': {
        const input = requestContextInputSchema.parse(rawInput);
        const recommendation = this.#recommendationsById.get(
          input.recommendationId,
        );
        if (!recommendation) throw new McpToolError('NOT_FOUND');
        if (recommendation.revision !== input.expectedRecommendationRevision) {
          throw new McpToolError('STALE_REVISION');
        }
        return {
          request: contextRequestSchema.parse({
            schemaVersion: '1',
            tenantId: FIXTURE_TENANT_ID,
            contextRequestId: `context-${recommendation.recommendationId}`,
            recommendationId: recommendation.recommendationId,
            focusedQuestion:
              input.focusedQuestion ??
              'Which approved metric set should I use in the board response?',
            missingFacts:
              recommendation.missingFacts.length > 0
                ? recommendation.missingFacts
                : ['user confirmation'],
            state: 'open',
            responseEvidenceRefs: [],
            createdAt: FIXTURE_NOW,
          }),
        };
      }
      case 'prepare_asana_action': {
        const input = prepareAsanaActionInputSchema.parse(rawInput);
        const recommendation = this.#recommendationsById.get(
          input.recommendationId,
        );
        if (!recommendation) throw new McpToolError('NOT_FOUND');
        if (recommendation.revision !== input.expectedRecommendationRevision) {
          throw new McpToolError('STALE_REVISION');
        }
        const proposalId = `proposal-asana-${recommendation.recommendationId}`;
        const handoff = proposalHandoffSchema.parse({
          proposalId,
          approvalUrl: productUrl(`/approvals/${proposalId}`),
          status: 'prepared',
          directEffectAvailable: false,
        });
        this.#proposals.set(proposalId, {
          handoff,
          status: handoff.status,
          updatedAt: FIXTURE_NOW,
        });
        return handoff;
      }
      case 'submit_for_approval': {
        const input = submitApprovalInputSchema.parse(rawInput);
        if (
          input.actionPlanId !== FIXTURE_ACTION_PLAN_ID ||
          input.expectedActionPlanRevision !== 1 ||
          input.actionPlanHash !== FIXTURE_ACTION_PLAN_HASH
        ) {
          throw new McpToolError('STALE_REVISION');
        }
        const handoff = proposalHandoffSchema.parse({
          proposalId: FIXTURE_APPROVAL_PROPOSAL_ID,
          approvalUrl: productUrl(`/approvals/${FIXTURE_APPROVAL_PROPOSAL_ID}`),
          status: 'pending_approval',
          directEffectAvailable: false,
        });
        this.#proposals.set(FIXTURE_APPROVAL_PROPOSAL_ID, {
          handoff,
          status: handoff.status,
          updatedAt: FIXTURE_NOW,
        });
        return handoff;
      }
      case 'get_approval_status': {
        const input = getApprovalStatusInputSchema.parse(rawInput);
        const proposal = this.#proposals.get(input.proposalId);
        if (!proposal) throw new McpToolError('NOT_FOUND');
        return getApprovalStatusResultSchema.parse({
          proposalId: proposal.handoff.proposalId,
          status: proposal.status,
          approvalUrl: proposal.handoff.approvalUrl,
          updatedAt: proposal.updatedAt,
        });
      }
      case 'get_connector_status': {
        const input = getConnectorStatusInputSchema.parse(rawInput);
        return {
          connectors:
            input.connectorId === undefined
              ? this.#connectors
              : this.#connectors.filter(
                  ({ connectorId }) => connectorId === input.connectorId,
                ),
        };
      }
      case 'get_sla_metrics': {
        const input = getSlaMetricsInputSchema.parse(rawInput);
        return {
          snapshot: {
            schemaVersion: '1',
            window: input.window,
            measuredAt: FIXTURE_NOW,
            pendingCount: this.#summaries.filter(
              ({ status }) => status === 'pending',
            ).length,
            overdueCount: this.#summaries.filter(
              ({ status }) => status === 'overdue',
            ).length,
            answeredCount: this.#summaries.filter(
              ({ status }) => status === 'answered',
            ).length,
            resolvedCount: this.#summaries.filter(
              ({ status }) => status === 'resolved',
            ).length,
            responseTimeP50Ms: 42_000,
            responseTimeP95Ms: 118_000,
            ingestionLagP95Ms: 24_000,
          },
        };
      }
    }
  }
}

export const publicFixtureScope: McpRequestScope = Object.freeze({
  kind: 'public_fixture',
  tenantId: FIXTURE_TENANT_ID,
  userId: FIXTURE_USER_ID,
  authorizationEpoch: FIXTURE_AUTHORIZATION_EPOCH,
});

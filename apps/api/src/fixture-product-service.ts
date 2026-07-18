import { createHash } from 'node:crypto';

import {
  actionRecommendationSchema,
  citedDraftResultSchema,
  communicationDetailViewSchema,
  communicationSummaryViewSchema,
  connectorStatusViewSchema,
  contextRequestSchema,
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
  type ActionRecommendation,
  type CitedDraftResult,
  type CommunicationDetailView,
  type CommunicationSummaryView,
  type ConnectorStatusView,
  type ContextRequest,
  type ProposalHandoff,
} from '@chief/contracts';

import {
  dashboardMetricsResultSchema,
  executionStatusResultSchema,
  ProductServiceError,
  type DashboardMetricsResult,
  type ExecutionStatusResult,
  type ProductRequestContext,
  type ProductService,
} from './product-service.js';

const FIXTURE_NOW = '2026-07-17T12:00:00.000Z';
const FIXTURE_TENANT_ID = 'tenant_public_assessment';
const FIXTURE_USER_ID = 'user_public_evaluator';
const FIXTURE_SCOPE_HASH = sha256('public-assessment-scope');
const FIXTURE_PROFILE_HASH = sha256('fixture-generation-profile');
const FIXTURE_SNAPSHOT_HASH = sha256('fixture-retrieval-snapshot');
const FIXTURE_ACTION_PLAN_ID = 'action_plan_fixture_reply';
const FIXTURE_ACTION_PLAN_HASH = sha256('action-plan-fixture-reply-v1');
const FIXTURE_EFFECT_DISABLED_PROPOSAL_ID = 'proposal_fixture_effect_disabled';
const THREAD_CHANNELS: Readonly<Record<string, 'email' | 'sms'>> =
  Object.freeze({
    'thread-1': 'email',
    'thread-2': 'email',
    'thread-3': 'sms',
    'thread-4': 'email',
  });

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyedDigest(value: string): string {
  return `h1_v1_${createHash('sha256').update(value).digest('base64url')}`;
}

function normalizeProductOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProductServiceError(
      'INVALID_INPUT',
      'Product base URL must be a credential-free HTTPS origin.',
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
    throw new ProductServiceError(
      'INVALID_INPUT',
      'Product base URL must be a credential-free HTTPS origin.',
    );
  }
  return url.origin;
}

function productUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/u, '')}${path}`;
}

function citation(label: string, index: number) {
  return {
    citationId: `citation-${index}`,
    sourceId: `source-${index}`,
    sourceVersion: '1',
    chunkId: `chunk-${index}`,
    label,
    contentHash: sha256(`citation-${index}`),
    hydratedUnderAuthorizationEpoch: 1,
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

function makeSummary(
  baseUrl: string,
  input: {
    readonly index: number;
    readonly thread: number;
    readonly status: 'pending' | 'answered' | 'overdue' | 'resolved';
    readonly sender: string;
    readonly subject: string;
    readonly excerpt: string;
    readonly timestamp: string;
    readonly attachments?: number;
    readonly direction?: 'inbound' | 'outbound';
  },
): CommunicationSummaryView {
  const channel = THREAD_CHANNELS[`thread-${input.thread}`];
  if (channel === undefined)
    throw new Error('Fixture thread channel is missing.');
  return communicationSummaryViewSchema.parse({
    messageId: `message-${input.index}`,
    messageRevisionId: `message-revision-${input.index}-1`,
    revision: 1,
    threadId: `thread-${input.thread}`,
    direction: input.direction ?? 'inbound',
    status: input.status,
    channel,
    accountId:
      channel === 'sms' ? 'account-twilio-fixture' : 'account-gmail-fixture',
    brandId: 'brand-executive',
    senderDisplayName: input.sender,
    recipientDisplayNames: ['Avery Morgan'],
    subject: input.subject,
    excerpt: input.excerpt,
    attachmentCount: input.attachments ?? 0,
    sourceTimestamp: input.timestamp,
    productUrl: productUrl(
      baseUrl,
      `/communications/message-revision-${input.index}-1`,
    ),
  });
}

function communicationFixtures(baseUrl: string) {
  const summaries = [
    makeSummary(baseUrl, {
      index: 1,
      thread: 1,
      status: 'overdue',
      sender: 'Jordan Lee',
      subject: 'Friday launch decision',
      excerpt: 'Can we confirm the Friday launch and the owner for QA?',
      timestamp: '2026-07-17T10:52:00.000Z',
      attachments: 1,
    }),
    makeSummary(baseUrl, {
      index: 2,
      thread: 2,
      status: 'pending',
      sender: 'Priya Shah',
      subject: 'Board update numbers',
      excerpt: 'Please send the approved pipeline numbers for the board note.',
      timestamp: '2026-07-17T11:06:00.000Z',
    }),
    makeSummary(baseUrl, {
      index: 3,
      thread: 3,
      status: 'pending',
      sender: 'Mateo Ruiz',
      subject: 'Customer escalation',
      excerpt: 'The customer needs an owner and next update time today.',
      timestamp: '2026-07-17T11:21:00.000Z',
    }),
    makeSummary(baseUrl, {
      index: 4,
      thread: 1,
      status: 'answered',
      sender: 'Avery Morgan',
      subject: 'Re: Friday launch decision',
      excerpt: 'I am checking the QA dependency and will confirm shortly.',
      timestamp: '2026-07-17T11:28:00.000Z',
      direction: 'outbound',
    }),
    makeSummary(baseUrl, {
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
                    baseUrl,
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

function connectorFixtures(baseUrl: string): readonly ConnectorStatusView[] {
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
      productUrl: productUrl(baseUrl, '/settings/connectors/gmail'),
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
      productUrl: productUrl(baseUrl, '/settings/connectors/twilio-sms'),
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
      productUrl: productUrl(baseUrl, '/settings/connectors/microsoft-graph'),
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
      productUrl: productUrl(baseUrl, '/settings/connectors/asana'),
    }),
  ]);
}

function recommendationFixtures(): ReadonlyMap<string, ActionRecommendation> {
  const values: ActionRecommendation[] = [
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
      citations: [
        citation('Launch readiness task SEC-4821 · due Friday', 11),
        citation('Friday launch decision · QA owner requested', 16),
      ],
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

function initialDraftBody(recommendation: ActionRecommendation): string {
  return recommendation.actionType === 'request_context'
    ? 'I am confirming the approved figures and will follow up with a sourced update.'
    : 'Thanks for the note. QA ownership is confirmed, and I will send the final launch update today.';
}

function decodeCursor(cursor: string | undefined, binding: string | undefined) {
  if (cursor === undefined) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [version, offsetValue, cursorStatus] = decoded.split(':');
    const offset = Number(offsetValue);
    if (
      version !== 'fixture-v1' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      cursorStatus !== (binding ?? '*')
    ) {
      throw new Error('invalid');
    }
    return offset;
  } catch {
    throw new ProductServiceError(
      'BAD_CURSOR',
      'The pagination cursor is invalid for this filtered result set.',
    );
  }
}

function encodeCursor(offset: number, binding: string | undefined): string {
  return Buffer.from(`fixture-v1:${offset}:${binding ?? '*'}`, 'utf8').toString(
    'base64url',
  );
}

function communicationListCursorBinding(input: {
  readonly status?: string;
  readonly query?: string;
  readonly channel?: string;
  readonly accountFilter?: string;
  readonly brandFilter?: string;
}): string {
  return sha256(
    JSON.stringify({
      status: input.status ?? null,
      query: input.query?.trim().toLocaleLowerCase('en-US') ?? null,
      channel: input.channel ?? null,
      accountFilter: input.accountFilter ?? null,
      brandFilter: input.brandFilter ?? null,
    }),
  );
}

export function createFixtureRequestContext(): ProductRequestContext {
  return serverRequestContextSchema.parse({
    actor: {
      authoritySource: 'verified_identity',
      tenantId: FIXTURE_TENANT_ID,
      userId: FIXTURE_USER_ID,
      accountScopes: [
        'account-gmail-fixture',
        'account-twilio-fixture',
        'account-asana-fixture',
      ],
      brandScopes: ['brand-executive'],
      grants: [
        'communications:read',
        'communications:draft',
        'communications:submit',
        'asana:prepare',
        'metrics:read',
      ],
      membershipVersion: 1,
      verifiedClaimsHash: sha256('fixture-verified-claims'),
      verifiedAt: FIXTURE_NOW,
    },
    retrievalScope: {
      derivation: 'server_grants',
      tenantId: FIXTURE_TENANT_ID,
      accountIds: [
        'account-gmail-fixture',
        'account-twilio-fixture',
        'account-asana-fixture',
      ],
      brandIds: ['brand-executive'],
      authorizationEpoch: 1,
      scopeHash: FIXTURE_SCOPE_HASH,
    },
  });
}

export class FixtureProductService implements ProductService {
  readonly #summaries: readonly CommunicationSummaryView[];
  readonly #details: ReadonlyMap<string, CommunicationDetailView>;
  readonly #connectors: readonly ConnectorStatusView[];
  readonly #recommendationsByMessage: ReadonlyMap<string, ActionRecommendation>;
  readonly #recommendationsById: ReadonlyMap<string, ActionRecommendation>;
  readonly #proposals = new Map<
    string,
    {
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
  >();
  readonly #baseUrl: string;

  public constructor(baseUrl: string) {
    this.#baseUrl = normalizeProductOrigin(baseUrl);
    const communications = communicationFixtures(this.#baseUrl);
    this.#summaries = communications.summaries;
    this.#details = communications.details;
    this.#connectors = connectorFixtures(this.#baseUrl);
    this.#recommendationsByMessage = recommendationFixtures();
    this.#recommendationsById = new Map(
      [...this.#recommendationsByMessage.values()].map((value) => [
        value.recommendationId,
        value,
      ]),
    );
    this.#proposals.set(FIXTURE_EFFECT_DISABLED_PROPOSAL_ID, {
      handoff: proposalHandoffSchema.parse({
        proposalId: FIXTURE_EFFECT_DISABLED_PROPOSAL_ID,
        approvalUrl: productUrl(
          this.#baseUrl,
          `/approvals/${FIXTURE_EFFECT_DISABLED_PROPOSAL_ID}`,
        ),
        status: 'pending_approval',
        directEffectAvailable: false,
      }),
      status: 'approved',
      updatedAt: FIXTURE_NOW,
    });
  }

  #assertContext(context: ProductRequestContext): void {
    const parsed = serverRequestContextSchema.parse(context);
    if (
      JSON.stringify(parsed) !== JSON.stringify(createFixtureRequestContext())
    ) {
      throw new ProductServiceError(
        'FORBIDDEN_AUTHORITY',
        'The public assessment authority envelope is selected by the server.',
      );
    }
  }

  public dashboardMetrics(
    context: ProductRequestContext,
    input: { readonly window: '24h' | '7d' | '30d' },
  ): DashboardMetricsResult {
    this.#assertContext(context);
    const snapshot = this.getSlaMetrics(context, input).snapshot;
    const channelCounts = new Map<string, number>();
    for (const communication of this.#summaries) {
      const channel = THREAD_CHANNELS[communication.threadId];
      if (channel === undefined) {
        throw new ProductServiceError(
          'INVALID_INPUT',
          'Fixture communication channel metadata is incomplete.',
        );
      }
      channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
    }
    return dashboardMetricsResultSchema.parse({
      snapshot,
      totalCommunications: this.#summaries.length,
      pendingApprovalCount: this.#proposals.size,
      channelBreakdown: [...channelCounts.entries()].map(
        ([channel, count]) => ({ channel, count }),
      ),
    });
  }

  public listCommunications(
    context: ProductRequestContext,
    input: {
      readonly status?: 'pending' | 'answered' | 'overdue' | 'resolved';
      readonly query?: string;
      readonly channel?: string;
      readonly accountFilter?: string;
      readonly brandFilter?: string;
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    this.#assertContext(context);
    const normalizedQuery = input.query?.trim().toLocaleLowerCase('en-US');
    const filtered = this.#summaries.filter((communication) => {
      if (input.status !== undefined && communication.status !== input.status)
        return false;
      if (
        input.channel !== undefined &&
        communication.channel !== input.channel
      )
        return false;
      if (
        input.accountFilter !== undefined &&
        communication.accountId !== input.accountFilter
      )
        return false;
      if (
        input.brandFilter !== undefined &&
        communication.brandId !== input.brandFilter
      )
        return false;
      if (normalizedQuery === undefined) return true;
      return [
        communication.senderDisplayName,
        ...communication.recipientDisplayNames,
        communication.subject,
        communication.excerpt,
        communication.channel,
        communication.accountId,
        communication.brandId,
      ].some((value) =>
        value?.toLocaleLowerCase('en-US').includes(normalizedQuery),
      );
    });
    const binding = communicationListCursorBinding(input);
    const offset = decodeCursor(input.cursor, binding);
    if (offset > filtered.length) {
      throw new ProductServiceError(
        'BAD_CURSOR',
        'Cursor is past the result set.',
      );
    }
    const items = filtered.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return listCommunicationsResultSchema.parse({
      items,
      totalCount: filtered.length,
      ...(nextOffset < filtered.length
        ? { nextCursor: encodeCursor(nextOffset, binding) }
        : {}),
    });
  }

  public getCommunication(
    context: ProductRequestContext,
    input: { readonly messageRevisionId: string },
  ) {
    this.#assertContext(context);
    const communication = this.#details.get(input.messageRevisionId);
    if (communication === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Communication was not found.',
      );
    }
    return getCommunicationResultSchema.parse({ communication });
  }

  public getThreadContext(
    context: ProductRequestContext,
    input: {
      readonly threadId: string;
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    this.#assertContext(context);
    const inThread = this.#summaries.filter(
      ({ threadId }) => threadId === input.threadId,
    );
    if (inThread.length === 0) {
      throw new ProductServiceError('NOT_FOUND', 'Thread was not found.');
    }
    const offset = decodeCursor(input.cursor, input.threadId);
    if (offset > inThread.length) {
      throw new ProductServiceError(
        'BAD_CURSOR',
        'Cursor is past the thread result set.',
      );
    }
    const communications = inThread.slice(offset, offset + input.limit);
    const nextOffset = offset + communications.length;
    const latest = inThread.at(-1);
    if (latest === undefined)
      throw new ProductServiceError('NOT_FOUND', 'Thread was not found.');
    const channel = THREAD_CHANNELS[input.threadId];
    if (channel === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Thread channel metadata was not found.',
      );
    }
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
    const thread = threadContextViewSchema.parse({
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
      productUrl: productUrl(this.#baseUrl, `/threads/${input.threadId}`),
    });
    return getThreadContextResultSchema.parse({ thread });
  }

  public getConnectorStatus(
    context: ProductRequestContext,
    input: { readonly connectorId?: string },
  ) {
    this.#assertContext(context);
    const connectors =
      input.connectorId === undefined
        ? this.#connectors
        : this.#connectors.filter(
            ({ connectorId }) => connectorId === input.connectorId,
          );
    return getConnectorStatusResultSchema.parse({ connectors });
  }

  public getRelatedAsanaWork(
    context: ProductRequestContext,
    input: { readonly messageRevisionId: string; readonly limit: number },
  ) {
    this.#assertContext(context);
    if (!this.#details.has(input.messageRevisionId)) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Communication was not found.',
      );
    }
    const items = [
      workObjectFactSchema.parse({
        kind: 'task',
        providerObjectId: 'SEC-4821',
        providerVersion: '2026-07-17T11:42:00.000Z',
        providerTimestamp: '2026-07-17T11:42:00.000Z',
        payloadFingerprint: sha256('asana-task-SEC-4821'),
      }),
      workObjectFactSchema.parse({
        kind: 'project',
        providerObjectId: 'asana-project-customer-operations',
        providerVersion: '2026-07-17T09:00:00.000Z',
        providerTimestamp: '2026-07-17T09:00:00.000Z',
        payloadFingerprint: sha256('asana-project-customer-operations'),
      }),
    ].slice(0, input.limit);
    return getRelatedAsanaWorkResultSchema.parse({ items });
  }

  public searchKnowledge(
    context: ProductRequestContext,
    input: {
      readonly queryText: string;
      readonly exactEntityRefs: readonly string[];
      readonly limit: number;
    },
  ) {
    this.#assertContext(context);
    const query = input.queryText.trim().toLocaleLowerCase('en-US');
    if (query.length === 0) {
      throw new ProductServiceError(
        'INVALID_INPUT',
        'Knowledge queries must contain a non-whitespace search term.',
      );
    }
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
        authorizationEpoch: context.retrievalScope?.authorizationEpoch ?? 1,
      }));
    const citations = candidates.map((candidate, index) => ({
      ...citation(`Authorized communication result ${index + 1}`, index + 20),
      chunkId: candidate.chunkId,
      sourceId: candidate.sourceId,
    }));
    return searchKnowledgeResultSchema.parse({ candidates, citations });
  }

  public recommendAction(
    context: ProductRequestContext,
    input: {
      readonly messageRevisionId: string;
      readonly expectedMessageRevision: number;
    },
  ) {
    this.#assertContext(context);
    const communication = this.#details.get(input.messageRevisionId);
    if (communication === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Communication was not found.',
      );
    }
    if (communication.revision !== input.expectedMessageRevision) {
      throw new ProductServiceError(
        'STALE_REVISION',
        'The communication revision changed before recommendation.',
      );
    }
    const recommendation = this.#recommendationsByMessage.get(
      input.messageRevisionId,
    );
    if (recommendation === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'No fixture recommendation exists for this communication.',
      );
    }
    return { recommendation };
  }

  public createDraft(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
    },
  ) {
    this.#assertContext(context);
    const recommendation = this.#recommendationsById.get(
      input.recommendationId,
    );
    if (recommendation === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    }
    if (recommendation.revision !== input.expectedRecommendationRevision) {
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    }
    const result = draftFor(
      recommendation,
      1,
      initialDraftBody(recommendation),
    );
    return { result };
  }

  public reviseDraft(
    context: ProductRequestContext,
    input: {
      readonly draftRevisionId: string;
      readonly expectedDraftRevision: number;
      readonly revisionInstruction: string;
    },
  ) {
    this.#assertContext(context);
    const match =
      /^draft-(recommendation-[a-zA-Z0-9_-]+)-revision-(\d+)$/u.exec(
        input.draftRevisionId,
      );
    const recommendation =
      match === null
        ? undefined
        : this.#recommendationsById.get(match[1] ?? '');
    if (match === null || recommendation === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Draft revision was not found.',
      );
    }
    const revision = Number(match[2]);
    if (revision !== input.expectedDraftRevision || revision !== 1) {
      throw new ProductServiceError(
        'STALE_REVISION',
        'Only the deterministic first fixture revision can be revised.',
      );
    }
    const current = draftFor(
      recommendation,
      1,
      initialDraftBody(recommendation),
    );
    const result = draftFor(
      recommendation,
      2,
      `${current.draft.body}\n\nRevision note: ${input.revisionInstruction}`,
      current.draft.draftRevisionId,
    );
    return { result };
  }

  public requestContext(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
      readonly focusedQuestion?: string;
    },
  ) {
    this.#assertContext(context);
    const recommendation = this.#recommendationsById.get(
      input.recommendationId,
    );
    if (recommendation === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    }
    if (recommendation.revision !== input.expectedRecommendationRevision) {
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    }
    const request: ContextRequest = contextRequestSchema.parse({
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
    });
    return { request };
  }

  public prepareApproval(
    context: ProductRequestContext,
    input: {
      readonly actionPlanId: string;
      readonly expectedActionPlanRevision: number;
      readonly actionPlanHash: string;
    },
  ) {
    this.#assertContext(context);
    if (
      input.actionPlanId !== FIXTURE_ACTION_PLAN_ID ||
      input.expectedActionPlanRevision !== 1 ||
      input.actionPlanHash !== FIXTURE_ACTION_PLAN_HASH
    ) {
      throw new ProductServiceError(
        'STALE_REVISION',
        'Approval preparation requires the exact immutable action-plan revision and hash.',
      );
    }
    const proposalId = 'proposal-fixture-reply-v1';
    const handoff = proposalHandoffSchema.parse({
      proposalId,
      approvalUrl: productUrl(this.#baseUrl, `/approvals/${proposalId}`),
      status: 'pending_approval',
      directEffectAvailable: false,
    });
    this.#proposals.set(proposalId, {
      handoff,
      status: handoff.status,
      updatedAt: FIXTURE_NOW,
    });
    return handoff;
  }

  public prepareAsanaAction(
    context: ProductRequestContext,
    input: {
      readonly recommendationId: string;
      readonly expectedRecommendationRevision: number;
    },
  ) {
    this.#assertContext(context);
    const recommendation = this.#recommendationsById.get(
      input.recommendationId,
    );
    if (recommendation === undefined) {
      throw new ProductServiceError(
        'NOT_FOUND',
        'Recommendation was not found.',
      );
    }
    if (recommendation.revision !== input.expectedRecommendationRevision) {
      throw new ProductServiceError(
        'STALE_REVISION',
        'Recommendation revision is stale.',
      );
    }
    const proposalId = `proposal-asana-${recommendation.recommendationId}`;
    const handoff = proposalHandoffSchema.parse({
      proposalId,
      approvalUrl: productUrl(this.#baseUrl, `/approvals/${proposalId}`),
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

  public prepareDraftApproval(): never {
    throw new ProductServiceError(
      'NOT_FOUND',
      'Draft approval preparation is available only through durable composition.',
    );
  }

  public approveProposal(): never {
    throw new ProductServiceError(
      'FORBIDDEN_AUTHORITY',
      'Approval is available only through durable server-authorized composition.',
    );
  }

  public getApprovalStatus(
    context: ProductRequestContext,
    input: { readonly proposalId: string },
  ) {
    this.#assertContext(context);
    const proposal = this.#proposals.get(input.proposalId);
    if (proposal === undefined) {
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    }
    return getApprovalStatusResultSchema.parse({
      proposalId: proposal.handoff.proposalId,
      status: proposal.status,
      approvalUrl: proposal.handoff.approvalUrl,
      updatedAt: proposal.updatedAt,
    });
  }

  public getExecutionStatus(
    context: ProductRequestContext,
    input: { readonly proposalId: string },
  ): ExecutionStatusResult {
    this.#assertContext(context);
    if (!this.#proposals.has(input.proposalId)) {
      throw new ProductServiceError('NOT_FOUND', 'Proposal was not found.');
    }
    if (input.proposalId === FIXTURE_EFFECT_DISABLED_PROPOSAL_ID) {
      return executionStatusResultSchema.parse({
        proposalId: input.proposalId,
        runtimeMode: 'fixture',
        storageMode: 'durable',
        effectPolicy: 'effect_disabled',
        externalEffect: false,
        status: 'effect_disabled',
        receipt: {
          kind: 'effect_disabled',
          operationId: 'operation-fixture-no-effect',
          artifactHash: sha256('artifact-fixture-no-effect'),
          stableIdempotencyKey: sha256('operation-fixture-no-effect'),
          observedAt: FIXTURE_NOW,
        },
      });
    }
    return executionStatusResultSchema.parse({
      proposalId: input.proposalId,
      runtimeMode: 'fixture',
      storageMode: 'durable',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'pending_approval',
    });
  }

  public getSlaMetrics(
    context: ProductRequestContext,
    input: { readonly window: '24h' | '7d' | '30d' },
  ) {
    this.#assertContext(context);
    return getSlaMetricsResultSchema.parse({
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
    });
  }
}

export function createFixtureProductService(
  baseUrl = 'https://chief.example.test',
): ProductService {
  return new FixtureProductService(baseUrl);
}

export const fixtureProductReferences = Object.freeze({
  tenantId: FIXTURE_TENANT_ID,
  actionPlanId: FIXTURE_ACTION_PLAN_ID,
  actionPlanRevision: 1,
  actionPlanHash: FIXTURE_ACTION_PLAN_HASH,
  effectDisabledProposalId: FIXTURE_EFFECT_DISABLED_PROPOSAL_ID,
});

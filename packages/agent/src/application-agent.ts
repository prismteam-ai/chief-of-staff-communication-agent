import {
  actionPlanSchema,
  actionRecommendationSchema,
  citedDraftResultSchema,
  contextRequestSchema,
  draftRevisionSchema,
  type ActionPlan,
  type ActionRecommendation,
  type CitedDraftResult,
  type ContextRequest,
} from '@chief/contracts';
import {
  accountIdSchema,
  actionPlanIdSchema,
  draftIdSchema,
  draftRevisionIdSchema,
  messageRevisionIdSchema,
  operationIdSchema,
  recommendationIdSchema,
  tenantIdSchema,
  userIdSchema,
  type ConnectorAccountId,
  type KeyedDigestValue,
  type MessageRevisionId,
  type TenantId,
  type UserId,
} from '@chief/contracts/ids';
import type { ModelGateway } from '@chief/model-gateway';

import { deterministicId, immutableHash } from './canonical.js';
import { resolveFacts } from './evidence.js';
import type {
  CitedContextRetriever,
  CitedContext,
  EvidenceFact,
} from './evidence.js';
import {
  actionModelOutputSchema,
  draftModelOutputSchema,
  ModelDegradedError,
  runStructuredModel,
  type ModelRunReceipt,
} from './model-runtime.js';
import {
  agentSafetyBoundary,
  agentSafetyBoundaryHash,
  agentToolPolicy,
  containsPromptInjection,
} from './safety.js';
import {
  learnStyleProfile,
  type ApprovedStyleExample,
  type CommunicationChannel,
  type StyleProfile,
} from './style.js';

export interface AgentClock {
  now(): Date;
  monotonicMilliseconds(): number;
}

const systemClock: AgentClock = {
  now: () => new Date(),
  monotonicMilliseconds: () => performance.now(),
};

export interface RecommendationRequest {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly brandId: string;
  readonly sourceMessageRevisionId: MessageRevisionId;
  readonly sourceMessageRevision: number;
  readonly channel: CommunicationChannel;
  readonly subject?: string;
  readonly authoredText: string;
  readonly quotedHistory?: string;
  readonly scopeHash: string;
  readonly exactEntityRefs: readonly string[];
  readonly styleExamples: readonly ApprovedStyleExample[];
}

export interface RecommendationArtifact {
  readonly recommendation: ActionRecommendation;
  readonly immutableHash: string;
  readonly context: CitedContext;
  readonly styleProfile: StyleProfile;
  readonly contextRequest?: ContextRequest;
}

export type DraftPreparationOutcome =
  | {
      readonly kind: 'ready';
      readonly artifact: DraftArtifact;
    }
  | {
      readonly kind: 'needs_context';
      readonly request: ContextRequest;
    }
  | {
      readonly kind: 'degraded';
      readonly reason:
        'MODEL_UNAVAILABLE' | 'INVALID_MODEL_OUTPUT' | 'CHANNEL_LIMIT';
    }
  | {
      readonly kind: 'not_applicable';
      readonly actionType: ActionRecommendation['actionType'];
    };

export interface DraftArtifact {
  readonly result: CitedDraftResult;
  readonly immutableHash: string;
  readonly recommendationHash: string;
  readonly context: CitedContext;
  readonly styleProfile: StyleProfile;
}

export interface CreateDraftRequest {
  readonly recommendation: RecommendationArtifact;
  readonly expectedRecommendationRevision: number;
  readonly connectorAccountId: ConnectorAccountId;
  readonly recipientDigests: readonly KeyedDigestValue[];
  readonly subject?: string;
}

export interface DraftHeadReader {
  getCurrentRevision(input: {
    readonly tenantId: TenantId;
    readonly draftId: string;
  }): Promise<{
    readonly draftRevisionId: string;
    readonly revision: number;
  } | null>;
}

export interface RecommendationHeadReader {
  isCurrent(input: {
    readonly tenantId: TenantId;
    readonly sourceMessageRevisionId: MessageRevisionId;
    readonly recommendationId: string;
    readonly revision: number;
  }): Promise<boolean>;
}

export interface ReviseDraftRequest extends CreateDraftRequest {
  readonly base: DraftArtifact;
  readonly expectedDraftRevision: number;
  readonly revisionInstruction: string;
}

export class StaleAgentRevisionError extends Error {
  public constructor(
    public readonly code:
      | 'STALE_RECOMMENDATION'
      | 'STALE_DRAFT_REVISION'
      | 'UNSAFE_REVISION_INSTRUCTION',
  ) {
    super(code);
    this.name = 'StaleAgentRevisionError';
  }
}

function requestContextQuestion(missingFacts: readonly string[]): string {
  const fact = missingFacts[0]?.trim() || 'the intended outcome';
  const lower = fact.toLowerCase();
  if (/date|deadline|when/iu.test(lower))
    return `What exact date should the response use for ${fact}?`;
  if (/owner|assignee|who/iu.test(lower))
    return `Who should be identified as responsible for ${fact}?`;
  if (/budget|price|cost|amount/iu.test(lower))
    return `What approved amount should the response state for ${fact}?`;
  return `What should the response say about ${fact}?`;
}

function confidenceFor(
  facts: readonly EvidenceFact[],
  missingFacts: readonly string[],
  actionType: ActionRecommendation['actionType'],
): number {
  if (actionType === 'ignore_system' || actionType === 'no_action') return 0.9;
  const diversity = new Set(facts.map(({ sourceKind }) => sourceKind)).size;
  const relevanceScores = facts.flatMap(({ relevanceScore }) =>
    relevanceScore === undefined ? [] : [relevanceScore],
  );
  const relevanceAdjustment =
    relevanceScores.length === 0
      ? 0
      : (relevanceScores.reduce((total, score) => total + score, 0) /
          relevanceScores.length -
          0.5) *
        0.2;
  const value =
    0.5 +
    Math.min(0.32, facts.length * 0.12) +
    Math.min(0.15, diversity * 0.05) -
    Math.min(0.5, missingFacts.length * 0.2) +
    relevanceAdjustment;
  return Math.max(0, Math.min(0.99, Number(value.toFixed(2))));
}

const minimumActionConfidence = 0.67;

function reproducibility(input: {
  readonly gateway: ModelGateway;
  readonly routeId: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly context: CitedContext;
  readonly requestHash: string;
  readonly outcome: 'valid' | 'degraded';
  readonly receipt?: ModelRunReceipt;
}) {
  return {
    schemaVersion: '1' as const,
    selectedProfileManifestHash: input.gateway.profile.manifestHash,
    routeId: input.routeId,
    modelProfileId: input.gateway.profile.profileId,
    gatewayVersion: input.gateway.profile.gatewayVersion,
    promptHash: input.promptHash,
    policyHash: agentSafetyBoundaryHash,
    schemaHash: input.schemaHash,
    retrievalQueryHash: input.context.queryHash,
    retrievalSnapshotManifestHash: input.context.snapshotManifestHash,
    requestHash: input.requestHash,
    inputTokens: input.receipt?.inputTokens ?? 0,
    outputTokens: input.receipt?.outputTokens ?? 0,
    latencyMs: input.receipt?.latencyMs ?? 0,
    outcome: input.outcome,
  };
}

function emptyContext(request: RecommendationRequest): CitedContext {
  return Object.freeze({
    facts: Object.freeze([]),
    citations: Object.freeze([]),
    queryHash: immutableHash({
      tenantId: request.tenantId,
      scopeHash: request.scopeHash,
      authoredText: request.authoredText,
    }),
    snapshotManifestHash: immutableHash([]),
  });
}

function buildContextRequest(input: {
  readonly request: RecommendationRequest;
  readonly recommendationId: string;
  readonly missingFacts: readonly string[];
  readonly createdAt: string;
}): ContextRequest {
  const missingFacts =
    input.missingFacts.length > 0
      ? [...new Set(input.missingFacts.map((fact) => fact.trim()))].filter(
          Boolean,
        )
      : ['the intended outcome'];
  return contextRequestSchema.parse({
    schemaVersion: '1',
    tenantId: input.request.tenantId,
    contextRequestId: deterministicId('ctx', {
      recommendationId: input.recommendationId,
      missingFacts,
    }),
    recommendationId: input.recommendationId,
    focusedQuestion: requestContextQuestion(missingFacts),
    missingFacts,
    state: 'open',
    responseEvidenceRefs: [],
    createdAt: input.createdAt,
  });
}

function reasonSummary(
  actionType: ActionRecommendation['actionType'],
  facts: readonly EvidenceFact[],
  missingFacts: readonly string[],
): string {
  if (missingFacts.length > 0)
    return `More context is required before ${actionType.replaceAll('_', ' ')}: ${missingFacts[0]}.`;
  if (facts.length > 0)
    return `Recommend ${actionType.replaceAll('_', ' ')} based on ${facts.length} cited fact${facts.length === 1 ? '' : 's'}.`;
  return `Recommend ${actionType.replaceAll('_', ' ')} under deterministic communication policy.`;
}

function modelPrompt(input: {
  readonly request: RecommendationRequest;
  readonly context: CitedContext;
}): string {
  return JSON.stringify({
    task: 'select_next_action',
    untrustedInbound: {
      channel: input.request.channel,
      subject: input.request.subject,
      authoredText: input.request.authoredText,
      quotedHistory: input.request.quotedHistory,
    },
    authorizedFacts: input.context.facts.map((fact) => ({
      factId: fact.factId,
      sourceKind: fact.sourceKind,
      statement: fact.statement,
      citationId: fact.citation.citationId,
    })),
    constraints: {
      factsMustUseSuppliedIds: true,
      directEffectsForbidden: true,
      askForFocusedContextWhenCriticalFactsAreMissing: true,
    },
  });
}

function renderDraft(input: {
  readonly channel: CommunicationChannel;
  readonly style: StyleProfile;
  readonly facts: readonly EvidenceFact[];
  readonly contextQuestion?: string;
  readonly includeGreeting: boolean;
  readonly includeSignoff: boolean;
  readonly compact: boolean;
}): { readonly body: string; readonly facts: readonly EvidenceFact[] } | null {
  const greetingText: Record<StyleProfile['greeting'], string> = {
    hi: 'Hi,',
    hello: 'Hello,',
    hey: 'Hey,',
    dear: 'Dear team,',
    none: '',
  };
  const signoffText: Record<StyleProfile['signoff'], string> = {
    thanks: 'Thanks,',
    best: 'Best,',
    regards: 'Regards,',
    none: '',
  };
  const acknowledgement =
    input.style.tone === 'formal'
      ? 'Thank you for the message.'
      : 'Thanks for reaching out.';
  const facts = [...input.facts];
  const assemble = (): string => {
    const parts: string[] = [];
    if (
      input.channel === 'email' &&
      input.includeGreeting &&
      !input.compact &&
      input.style.greeting !== 'none'
    )
      parts.push(greetingText[input.style.greeting]);
    if (!input.compact) parts.push(acknowledgement);
    parts.push(...facts.map(({ statement }) => statement));
    if (input.contextQuestion) parts.push(input.contextQuestion);
    if (
      input.channel === 'email' &&
      input.includeSignoff &&
      !input.compact &&
      input.style.signoff !== 'none'
    )
      parts.push(signoffText[input.style.signoff]);
    return parts.filter(Boolean).join(input.channel === 'email' ? '\n\n' : ' ');
  };
  let body = assemble();
  while (body.length > input.style.maximumCharacters && facts.length > 1) {
    facts.pop();
    body = assemble();
  }
  if (!body || body.length > input.style.maximumCharacters) return null;
  return Object.freeze({ body, facts: Object.freeze(facts) });
}

export class ChiefCommunicationAgent {
  readonly #gateway: ModelGateway;
  readonly #retriever: CitedContextRetriever;
  readonly #clock: AgentClock;
  readonly #recommendationHeads: RecommendationHeadReader;
  readonly #draftHeads?: DraftHeadReader;

  public constructor(input: {
    readonly gateway: ModelGateway;
    readonly retriever: CitedContextRetriever;
    readonly recommendationHeads: RecommendationHeadReader;
    readonly clock?: AgentClock;
    readonly draftHeads?: DraftHeadReader;
  }) {
    this.#gateway = input.gateway;
    this.#retriever = input.retriever;
    this.#recommendationHeads = input.recommendationHeads;
    this.#clock = input.clock ?? systemClock;
    this.#draftHeads = input.draftHeads;
  }

  public async recommend(
    request: RecommendationRequest,
  ): Promise<RecommendationArtifact> {
    const safeRequest: RecommendationRequest = {
      ...request,
      tenantId: tenantIdSchema.parse(request.tenantId),
      userId: userIdSchema.parse(request.userId),
      sourceMessageRevisionId: messageRevisionIdSchema.parse(
        request.sourceMessageRevisionId,
      ),
    };
    const createdAt = this.#clock.now().toISOString();
    const styleProfile = learnStyleProfile({
      tenantId: safeRequest.tenantId,
      userId: safeRequest.userId,
      brandId: safeRequest.brandId,
      channel: safeRequest.channel,
      examples: safeRequest.styleExamples,
    });
    const injectionDetected = containsPromptInjection(
      `${safeRequest.authoredText}\n${safeRequest.quotedHistory ?? ''}`,
    );
    const context = injectionDetected
      ? emptyContext(safeRequest)
      : await this.#retriever.retrieve({
          tenantId: safeRequest.tenantId,
          userId: safeRequest.userId,
          brandId: safeRequest.brandId,
          scopeHash: safeRequest.scopeHash,
          queryText:
            `${safeRequest.subject ?? ''}\n${safeRequest.authoredText}`.trim(),
          exactEntityRefs: safeRequest.exactEntityRefs,
        });
    const prompt = modelPrompt({ request: safeRequest, context });
    const requestHash = immutableHash({
      tenantId: safeRequest.tenantId,
      userId: safeRequest.userId,
      brandId: safeRequest.brandId,
      sourceMessageRevisionId: safeRequest.sourceMessageRevisionId,
      sourceMessageRevision: safeRequest.sourceMessageRevision,
      channel: safeRequest.channel,
      subject: safeRequest.subject,
      authoredText: safeRequest.authoredText,
      quotedHistory: safeRequest.quotedHistory,
      scopeHash: safeRequest.scopeHash,
      exactEntityRefs: [...safeRequest.exactEntityRefs].sort(),
      styleProfileHash: styleProfile.profileHash,
    });
    let selectedFactIds: readonly string[] = [];
    let missingFacts: readonly string[];
    let actionType: ActionRecommendation['actionType'] = 'escalate';
    let urgency: ActionRecommendation['urgency'] = 'high';
    let receipt: ModelRunReceipt | undefined;
    let outcome: 'valid' | 'degraded' = 'valid';
    if (injectionDetected) {
      missingFacts = ['a trusted interpretation of the untrusted instruction'];
    } else if (context.facts.length === 0) {
      actionType = 'request_context';
      urgency = 'normal';
      missingFacts = ['relevant communication, organization, or Asana context'];
      outcome = 'degraded';
    } else {
      try {
        const model = await runStructuredModel({
          gateway: this.#gateway,
          route: 'action_context',
          schema: actionModelOutputSchema,
          prompt,
          context,
          style: styleProfile,
          now: () => this.#clock.monotonicMilliseconds(),
        });
        selectedFactIds = model.output.selectedFactIds;
        missingFacts = model.output.missingFacts;
        actionType = model.output.actionType;
        urgency = model.output.urgency;
        receipt = model.receipt;
      } catch (error) {
        if (!(error instanceof ModelDegradedError)) throw error;
        actionType = 'request_context';
        urgency = 'normal';
        missingFacts = ['a validated model recommendation'];
        outcome = 'degraded';
      }
    }
    let facts: readonly EvidenceFact[] = [];
    try {
      facts = resolveFacts(context, selectedFactIds);
    } catch {
      actionType = 'request_context';
      missingFacts = ['citation-supported facts'];
      outcome = 'degraded';
    }
    const confidence = confidenceFor(facts, missingFacts, actionType);
    if (
      !injectionDetected &&
      actionType !== 'ignore_system' &&
      actionType !== 'no_action' &&
      (missingFacts.length > 0 || confidence < minimumActionConfidence)
    )
      actionType = 'request_context';
    const recommendationId = recommendationIdSchema.parse(
      deterministicId('rec', {
        requestHash,
        actionType,
        urgency,
        selectedFactIds: facts.map(({ factId }) => factId),
        missingFacts,
      }),
    );
    const contentHash = immutableHash({
      recommendationId,
      revision: 1,
      sourceMessageRevisionId: safeRequest.sourceMessageRevisionId,
      actionType,
      urgency,
      factIds: facts.map(({ factId }) => factId),
      missingFacts,
      promptHash: immutableHash(prompt),
      policyHash: agentSafetyBoundaryHash,
    });
    const recommendation = actionRecommendationSchema.parse({
      schemaVersion: '1',
      tenantId: safeRequest.tenantId,
      recommendationId,
      revision: 1,
      sourceMessageRevisionId: safeRequest.sourceMessageRevisionId,
      actionType,
      structuredParameters: {
        artifactHash: contentHash,
        selectedFactIds: facts.map(({ factId }) => factId),
        toolAllowlist: [...agentToolPolicy.allowed],
        directEffectsAllowed: false,
      },
      confidence,
      urgency,
      reasonSummary: reasonSummary(actionType, facts, missingFacts),
      citations: facts.map(({ citation }) => citation),
      missingFacts,
      status: injectionDetected
        ? 'blocked'
        : actionType === 'request_context'
          ? 'needs_context'
          : 'current',
      reproducibility: reproducibility({
        gateway: this.#gateway,
        routeId: this.#gateway.profile.actionContextRoute,
        promptHash: immutableHash(prompt),
        schemaHash: immutableHash('actionModelOutputSchema:v1'),
        context,
        requestHash,
        outcome,
        receipt,
      }),
      createdAt,
    });
    const contextRequest =
      actionType === 'request_context' || injectionDetected
        ? buildContextRequest({
            request: safeRequest,
            recommendationId,
            missingFacts,
            createdAt,
          })
        : undefined;
    return Object.freeze({
      recommendation,
      immutableHash: contentHash,
      context,
      styleProfile,
      ...(contextRequest ? { contextRequest } : {}),
    });
  }

  public async createDraft(
    request: CreateDraftRequest,
  ): Promise<DraftPreparationOutcome> {
    await this.#assertRecommendationCurrent(request);
    if (request.recommendation.contextRequest)
      return Object.freeze({
        kind: 'needs_context',
        request: request.recommendation.contextRequest,
      });
    if (
      !['reply', 'acknowledge'].includes(
        request.recommendation.recommendation.actionType,
      )
    )
      return Object.freeze({
        kind: 'not_applicable',
        actionType: request.recommendation.recommendation.actionType,
      });
    return this.#prepareDraft(request, 1, false);
  }

  public async reviseDraft(
    request: ReviseDraftRequest,
  ): Promise<DraftPreparationOutcome> {
    await this.#assertRecommendationCurrent(request);
    if (containsPromptInjection(request.revisionInstruction))
      throw new StaleAgentRevisionError('UNSAFE_REVISION_INSTRUCTION');
    if (!this.#draftHeads)
      throw new StaleAgentRevisionError('STALE_DRAFT_REVISION');
    const base = request.base.result.draft;
    const head = await this.#draftHeads.getCurrentRevision({
      tenantId: base.tenantId,
      draftId: base.draftId,
    });
    if (
      !head ||
      head.revision !== request.expectedDraftRevision ||
      head.revision !== base.revision ||
      head.draftRevisionId !== base.draftRevisionId
    )
      throw new StaleAgentRevisionError('STALE_DRAFT_REVISION');
    return this.#prepareDraft(
      request,
      base.revision + 1,
      /shorter|concise|brief/iu.test(request.revisionInstruction),
      base.draftRevisionId,
      request.revisionInstruction,
    );
  }

  async #assertRecommendationCurrent(
    request: CreateDraftRequest,
  ): Promise<void> {
    const recommendation = request.recommendation.recommendation;
    if (
      recommendation.revision !== request.expectedRecommendationRevision ||
      !(await this.#recommendationHeads.isCurrent({
        tenantId: recommendation.tenantId,
        sourceMessageRevisionId: recommendation.sourceMessageRevisionId,
        recommendationId: recommendation.recommendationId,
        revision: request.expectedRecommendationRevision,
      }))
    )
      throw new StaleAgentRevisionError('STALE_RECOMMENDATION');
  }

  async #prepareDraft(
    request: CreateDraftRequest,
    revision: number,
    compact: boolean,
    supersedesRevisionId?: string,
    revisionInstruction?: string,
  ): Promise<DraftPreparationOutcome> {
    const recommendation = request.recommendation;
    const prompt = JSON.stringify({
      task:
        revision === 1 ? 'select_cited_draft_plan' : 'revise_cited_draft_plan',
      untrustedRevisionInstruction: revisionInstruction,
      recommendation: {
        actionType: recommendation.recommendation.actionType,
        urgency: recommendation.recommendation.urgency,
        citedFactIds: recommendation.context.facts.map(({ factId }) => factId),
      },
      approvedStyleProfile: {
        version: recommendation.styleProfile.version,
        tone: recommendation.styleProfile.tone,
        brevity: recommendation.styleProfile.brevity,
        greeting: recommendation.styleProfile.greeting,
        signoff: recommendation.styleProfile.signoff,
      },
      constraints: {
        suppliedFactIdsOnly: true,
        noDirectEffect: true,
        channel: recommendation.styleProfile.channel,
        maximumCharacters: recommendation.styleProfile.maximumCharacters,
      },
    });
    let model;
    try {
      model = await runStructuredModel({
        gateway: this.#gateway,
        route: 'draft',
        schema: draftModelOutputSchema,
        prompt,
        context: recommendation.context,
        style: recommendation.styleProfile,
        now: () => this.#clock.monotonicMilliseconds(),
      });
    } catch (error) {
      if (!(error instanceof ModelDegradedError)) throw error;
      return Object.freeze({ kind: 'degraded', reason: error.reason });
    }
    let facts: readonly EvidenceFact[];
    try {
      facts = resolveFacts(
        recommendation.context,
        model.output.selectedFactIds,
      );
    } catch {
      return Object.freeze({
        kind: 'degraded',
        reason: 'INVALID_MODEL_OUTPUT',
      });
    }
    if (model.output.responseMode === 'answer' && facts.length === 0)
      return Object.freeze({
        kind: 'degraded',
        reason: 'INVALID_MODEL_OUTPUT',
      });
    const rendered = renderDraft({
      channel: recommendation.styleProfile.channel,
      style: recommendation.styleProfile,
      facts,
      includeGreeting: model.output.includeGreeting,
      includeSignoff: model.output.includeSignoff,
      compact,
      ...(model.output.responseMode === 'request_context'
        ? { contextQuestion: requestContextQuestion(['the intended response']) }
        : {}),
    });
    if (!rendered)
      return Object.freeze({ kind: 'degraded', reason: 'CHANNEL_LIMIT' });
    const tenantId = tenantIdSchema.parse(
      recommendation.recommendation.tenantId,
    );
    const connectorAccountId = accountIdSchema.parse(
      request.connectorAccountId,
    );
    const draftId = draftIdSchema.parse(
      deterministicId('draft', {
        recommendationId: recommendation.recommendation.recommendationId,
        connectorAccountId,
      }),
    );
    const subject =
      recommendation.styleProfile.channel === 'email' && request.subject
        ? `Re: ${request.subject.replace(/^re:\s*/iu, '').trim()}`.slice(0, 998)
        : undefined;
    const contentHash = immutableHash({
      tenantId,
      draftId,
      revision,
      connectorAccountId,
      recipientDigests: request.recipientDigests,
      subject,
      body: rendered.body,
      citationIds: rendered.facts.map(({ citation }) => citation.citationId),
      styleProfileVersion: recommendation.styleProfile.version,
    });
    const draftRevisionId = draftRevisionIdSchema.parse(
      deterministicId('draftrev', { draftId, revision, contentHash }),
    );
    const renderedPayloadFingerprint = immutableHash({
      channel: recommendation.styleProfile.channel,
      connectorAccountId,
      recipientDigests: request.recipientDigests,
      subject,
      body: rendered.body,
      rendererId: `chief-${recommendation.styleProfile.channel}`,
      rendererVersion: '1',
    });
    const requestHash = immutableHash({
      recommendationHash: recommendation.immutableHash,
      revision,
      connectorAccountId,
      recipientDigests: request.recipientDigests,
      subject,
      revisionInstruction,
    });
    const draft = draftRevisionSchema.parse({
      schemaVersion: '1',
      tenantId,
      draftId,
      draftRevisionId,
      revision,
      connectorAccountId,
      sourceMessageRevisionId:
        recommendation.recommendation.sourceMessageRevisionId,
      recipientDigests: request.recipientDigests,
      subject,
      body: rendered.body,
      attachmentContentHashes: [],
      citations: rendered.facts.map(({ citation }) => citation),
      styleProfileVersion: recommendation.styleProfile.version,
      rendererId: `chief-${recommendation.styleProfile.channel}`,
      rendererVersion: '1',
      renderedPayloadFingerprint,
      contentHash,
      createdBy: 'agent',
      ...(supersedesRevisionId
        ? {
            supersedesRevisionId:
              draftRevisionIdSchema.parse(supersedesRevisionId),
          }
        : {}),
      reproducibility: reproducibility({
        gateway: this.#gateway,
        routeId: this.#gateway.profile.draftRoute,
        promptHash: immutableHash(prompt),
        schemaHash: immutableHash('draftModelOutputSchema:v1'),
        context: recommendation.context,
        requestHash,
        outcome: 'valid',
        receipt: model.receipt,
      }),
      createdAt: this.#clock.now().toISOString(),
    });
    const result = citedDraftResultSchema.parse({
      draft,
      factualCitationCount: draft.citations.length,
      unresolvedFacts: [],
      validation: 'passed',
    });
    const artifact: DraftArtifact = Object.freeze({
      result,
      immutableHash: immutableHash({
        draftRevisionId,
        contentHash,
        renderedPayloadFingerprint,
      }),
      recommendationHash: recommendation.immutableHash,
      context: recommendation.context,
      styleProfile: recommendation.styleProfile,
    });
    return Object.freeze({ kind: 'ready', artifact });
  }

  public prepareApprovalActionPlan(input: {
    readonly artifact: DraftArtifact;
    readonly policyVersion: string;
    readonly expiresAt: string;
  }): ActionPlan {
    const draft = input.artifact.result.draft;
    const operationId = operationIdSchema.parse(
      deterministicId('op', {
        draftRevisionId: draft.draftRevisionId,
        renderedPayloadFingerprint: draft.renderedPayloadFingerprint,
      }),
    );
    const actionPlanId = actionPlanIdSchema.parse(
      deterministicId('plan', {
        draftId: draft.draftId,
        revision: draft.revision,
        operationId,
      }),
    );
    const core = {
      schemaVersion: '1' as const,
      tenantId: draft.tenantId,
      actionPlanId,
      revision: 1,
      sourceMessageRevisionId: draft.sourceMessageRevisionId,
      operations: [
        {
          kind: 'send_message' as const,
          operationId,
          connectorAccountId: draft.connectorAccountId,
          draftRevisionId: draft.draftRevisionId,
          recipientDigests: draft.recipientDigests,
          renderedPayloadFingerprint: draft.renderedPayloadFingerprint,
        },
      ],
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt,
      createdAt: draft.createdAt,
    };
    return actionPlanSchema.parse({
      ...core,
      canonicalHash: immutableHash(core),
    });
  }
}

export const applicationAgentBoundary = Object.freeze({
  ...agentSafetyBoundary,
  directAsanaMutation: false,
  toolAllowlist: agentToolPolicy.allowed,
  maximumSteps: agentToolPolicy.maximumSteps,
  maximumSchemaRepairs: agentToolPolicy.maximumSchemaRepairs,
} as const);

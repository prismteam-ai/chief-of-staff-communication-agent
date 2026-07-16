import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  applyTransition,
  routeByConfidence,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type Draft,
  type Recommendation,
  type TransitionRecord,
} from '@chief-of-staff/shared';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import type { AgentRunner } from './agent/agent.js';
import { createRetrieveContextTool } from './tools/retrieve-context.js';
import { shapeRecommendation } from './tools/recommend-action.js';
import { shapeDraft, buildStyleInstructions } from './tools/draft-reply.js';
import type { AgentCommunicationRecord, AgentCommunicationsRepo } from './communications-repo.js';
import type {
  ConversationEvent,
  ConversationEventStore,
} from './memory/conversation-event-store.js';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/**
 * One agent turn over one communication (design.md §5, Task 5). Fully dependency-injected so the
 * integration test drives it with a fake model, an in-memory retrieval index, and fake repos — no
 * AWS, no Bedrock. The orchestration:
 *
 *   1. read the communication record (must be in `ingested`)
 *   2. load conversation history from the ConversationEventStore (session = threadKey)
 *   3. classify via the AgentRunner (retrieveContext available as a tool) → Recommendation
 *   4. apply the confidence GATE IN CODE (`routeByConfidence`) — never a prompt instruction
 *   5a. below threshold → transition ingested→recommended→needs_context, persist, STOP (no draft)
 *   5b. at/above       → draft, transition ingested→recommended→drafted, persist recommendation+draft
 *   6. append the turn to the ConversationEventStore (idempotent tokens from the provider msg id)
 *
 * Logging/metrics carry ids, action type, confidence, and route only — NEVER the message body,
 * participant addresses, or draft text (mirrors `processor-logic.ts`'s discipline; Task 5
 * constraint 6).
 */

export interface RunAgentTurnInput {
  commId: string;
  accountId: string;
}

export type AgentTurnOutcome =
  | { outcome: 'recommended_and_drafted'; commId: string; actionType: string; confidence: number }
  | { outcome: 'needs_context'; commId: string; actionType: string; confidence: number }
  | { outcome: 'skipped'; commId: string; reason: string }
  | { outcome: 'failed'; commId: string; error: string };

export interface RunAgentTurnDeps {
  communicationsRepo: AgentCommunicationsRepo;
  retrievalIndex: RetrievalIndex;
  agentRunner: AgentRunner;
  conversationStore: ConversationEventStore;
  confidenceThreshold?: number;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  now?: () => Date;
  /** Injectable wall-clock for the duration metric; defaults to `Date.now`. */
  clock?: () => number;
}

/** The sender is the participant with role `from` — the AgentCore Memory actor (design.md §5). */
function senderId(record: AgentCommunicationRecord): string {
  const from = record.participants.find((p) => p.role === 'from');
  return from?.id ?? 'unknown';
}

export async function runAgentTurn(
  input: RunAgentTurnInput,
  deps: RunAgentTurnDeps,
): Promise<AgentTurnOutcome> {
  const {
    communicationsRepo,
    retrievalIndex,
    agentRunner,
    conversationStore,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    log,
    metricsClient,
    now = () => new Date(),
    clock = () => Date.now(),
  } = deps;
  const { commId, accountId } = input;
  const startedAt = clock();

  try {
    const record = await communicationsRepo.getById(commId);
    if (!record) {
      log.warn('Communication not found for agent turn — skipping', { commId });
      return { outcome: 'skipped', commId, reason: 'not_found' };
    }
    if (record.status !== 'ingested') {
      // Idempotency: a redelivery of an already-processed communication is a no-op, not a re-run.
      log.info('Communication not in ingested state — skipping agent turn', {
        commId,
        status: record.status,
      });
      return { outcome: 'skipped', commId, reason: `status_${record.status}` };
    }

    const sessionId = record.threadKey;
    const actorId = senderId(record);

    const history = await conversationStore.loadSessionEvents(sessionId, actorId);
    const historyText = history.map((e) => `[${e.kind}] ${e.text}`);

    const retrieveContextTool = createRetrieveContextTool({ retrievalIndex, accountId });

    // --- classify -----------------------------------------------------------------------------
    const classifyOutput = await agentRunner.classify({
      sessionId,
      messageText: record.body,
      history: historyText,
      retrieveContextTool,
    });
    // Validate + shape into the shared Recommendation (throws on an out-of-enum/out-of-range model
    // response rather than persisting a malformed recommendation).
    const recommendation: Recommendation = shapeRecommendation(
      { commId, accountId },
      classifyOutput,
    );
    metricsClient.addMetric('RecommendationProduced', MetricUnit.Count, 1);

    // --- confidence GATE, in code (Task 5 constraint 3) --------------------------------------
    const route = routeByConfidence(recommendation.confidence, confidenceThreshold);
    log.info('Recommendation produced', {
      commId,
      actionType: recommendation.actionType,
      confidence: recommendation.confidence,
      route,
    });

    if (route === 'needs_context') {
      const transitions = twoHopTransitions({
        commId,
        accountId,
        to: 'needs_context',
        now,
      });
      await communicationsRepo.persistOutcome({
        commId,
        status: 'needs_context',
        recommendation,
        transitions,
      });
      await appendTurn(conversationStore, sessionId, actorId, record, {
        recommendation,
      });
      log.info('Routed to needs_context (below confidence threshold)', {
        commId,
        confidence: recommendation.confidence,
        threshold: confidenceThreshold,
      });
      return {
        outcome: 'needs_context',
        commId,
        actionType: recommendation.actionType,
        confidence: recommendation.confidence,
      };
    }

    // --- draft (at/above threshold) ----------------------------------------------------------
    const draftOutput = await agentRunner.draft({
      sessionId,
      messageText: record.body,
      history: historyText,
      retrieveContextTool,
      actionType: recommendation.actionType,
      styleInstructions: buildStyleInstructions(undefined),
    });
    const draft: Draft = shapeDraft({ commId, accountId }, draftOutput);
    metricsClient.addMetric('DraftProduced', MetricUnit.Count, 1);

    const transitions = twoHopTransitions({ commId, accountId, to: 'drafted', now });
    await communicationsRepo.persistOutcome({
      commId,
      status: 'drafted',
      recommendation,
      draft,
      transitions,
    });
    await appendTurn(conversationStore, sessionId, actorId, record, { recommendation, draft });

    log.info('Recommendation + draft persisted', {
      commId,
      actionType: recommendation.actionType,
      confidence: recommendation.confidence,
    });
    return {
      outcome: 'recommended_and_drafted',
      commId,
      actionType: recommendation.actionType,
      confidence: recommendation.confidence,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No body/PII in the error path either — just the id and the error message.
    log.error('Agent turn failed', { commId, error: message });
    metricsClient.addMetric('AgentTurnFailed', MetricUnit.Count, 1);
    return { outcome: 'failed', commId, error: message };
  } finally {
    metricsClient.addMetric('AgentTurnDuration', MetricUnit.Milliseconds, clock() - startedAt);
  }
}

/**
 * Builds the two transition records for one agent turn: `ingested → recommended` then
 * `recommended → <to>` (`drafted` or `needs_context`). Both are validated by `applyTransition`
 * against the shared state machine, so an illegal move throws (and the turn fails visibly) rather
 * than persisting an impossible state.
 */
function twoHopTransitions(params: {
  commId: string;
  accountId: string;
  to: 'drafted' | 'needs_context';
  now: () => Date;
}): TransitionRecord[] {
  const { commId, accountId, to, now } = params;
  const first = applyTransition({
    commId,
    accountId,
    from: 'ingested',
    to: 'recommended',
    actorId: 'system',
    now,
  });
  const second = applyTransition({
    commId,
    accountId,
    from: 'recommended',
    to,
    actorId: 'system',
    now,
  });
  return [first, second];
}

/** Appends the user turn + the assistant turn to memory with deterministic, id-derived tokens. */
async function appendTurn(
  store: ConversationEventStore,
  sessionId: string,
  actorId: string,
  record: AgentCommunicationRecord,
  outcome: { recommendation: Recommendation; draft?: Draft },
): Promise<void> {
  const at = record.ts;
  const assistantSummary = outcome.draft
    ? `Recommended ${outcome.recommendation.actionType} (confidence ${outcome.recommendation.confidence}). Draft prepared.`
    : `Recommended ${outcome.recommendation.actionType} (confidence ${outcome.recommendation.confidence}). Routed to needs_context.`;

  const events: ConversationEvent[] = [
    { kind: 'user', at, text: record.body },
    { kind: 'assistant', at: new Date().toISOString(), text: assistantSummary },
  ];

  // Idempotent tokens derived from the provider message id (`externalId`) + ordinal, so a retried
  // invocation never double-writes the same turn (kit skill AgentCore rule 4).
  await store.appendEvents(sessionId, actorId, events, {
    clientTokenFor: (_event, ordinal) => `${record.externalId}:${ordinal}`,
  });
}

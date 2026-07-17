import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  applyTransition,
  routeRecommendation,
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
import { GENERIC_STYLE_CARD } from './tools/style-profile.js';
import { createManageAsanaTool } from './tools/manage-asana.js';
import type { AgentCommunicationRecord, AgentCommunicationsRepo } from './communications-repo.js';
import type { AgentAccountsRepo } from './accounts-repo.js';
import type { StyleProfileRepo } from './style/style-profile-repo.js';
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
 *   1. read the communication record (must be in `ingested` — the first-ever turn — OR
 *      `awaiting_reprocess` — a `supplyContext` re-run, Task 6 review fix, see below)
 *   2. load conversation history from the ConversationEventStore (session = threadKey), with any
 *      `suppliedContext` entries appended as additional history for a re-run turn
 *   3. classify via the AgentRunner (retrieveContext available as a tool) → Recommendation
 *   4. apply the confidence + actionType GATE IN CODE (`routeRecommendation`) — never a prompt
 *      instruction. Two gates, both in code (slowking fix 2 — closes the gap `state-machine.ts`
 *      already documented: the agent used to always draft once confidence cleared the threshold,
 *      regardless of `actionType`, so an `fyi_no_reply` newsletter or an `escalate`-worthy message
 *      still got a fabricated "reply" drafted AS the counterparty):
 *   5a. below threshold        → transition <entryState>→recommended→needs_context, persist, STOP (no draft)
 *   5b. at/above, fyi_no_reply → transition <entryState>→recommended→dismissed, persist, STOP (no draft;
 *       no reply is owed at all — the state machine's documented "no reply needed" outcome)
 *   5c. at/above, escalate     → transition <entryState>→recommended→needs_context, persist, STOP (no
 *       draft; urgent/high-stakes must surface to a human, never an auto-drafted reply)
 *   5d. at/above, otherwise    → draft, transition <entryState>→recommended→drafted, persist recommendation+draft
 *   6. append the turn to the ConversationEventStore (idempotent tokens from the provider msg id),
 *      isolated (`appendTurnIsolated`) so a memory-write failure never flips an already-persisted
 *      outcome to 'failed' — see the helper's doc comment for why that matters for redelivery
 *
 * ## Re-run entry point: `awaiting_reprocess` (Task 6 review fix)
 * `needs_context` communications used to have no way back to a real re-classification — the api
 * Lambda's `supplyContext` just flipped status to `drafted` directly, discarding the supplied text
 * and landing a draftless record where the UI's Approve action had nothing to approve. `supplyContext`
 * now persists the text (`suppliedContext`) and transitions to `awaiting_reprocess`, then re-enqueues
 * this commId to the SAME agent queue the ingest processor publishes to. This turn treats
 * `awaiting_reprocess` as an equally-legal ENTRY state to `ingested` (see `resolveEntryState` below)
 * — everything downstream (classify, gate, draft, transitions, memory append) is identical; only the
 * first transition's `from` differs (`awaiting_reprocess→recommended` instead of
 * `ingested→recommended`) and the prompt gains the supplied context as extra history.
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
  /** actionType `fyi_no_reply` at/above the confidence threshold (slowking fix 2): no reply is
   * owed, so the turn dismisses the communication instead of fabricating a draft. */
  | { outcome: 'dismissed_no_reply_needed'; commId: string; actionType: string; confidence: number }
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
  /**
   * Task 10 style seam deps: resolves `accountId -> userId` (the style-profiles table's key), then
   * looks up that user's style card + retrieves their embedded sent-reply exemplars. Optional so
   * every EXISTING test/call site that predates Task 10 keeps compiling unchanged; when omitted the
   * draft step falls back to the pre-Task-10 behavior (`buildStyleInstructions` with no accounts/
   * style-profile deps resolves `userId` as `undefined`, which is the documented `GENERIC_STYLE_CARD`
   * fallback path).
   */
  accountsRepo?: AgentAccountsRepo;
  styleProfileRepo?: StyleProfileRepo;
  /** Injectable embedder for style-exemplar retrieval so tests never call Bedrock; defaults to the
   * real Cohere Embed v4 helper inside `getStyleProfile` when omitted. */
  styleEmbed?: (text: string) => Promise<number[]>;
}

/** The sender is the participant with role `from` — the AgentCore Memory actor (design.md §5). */
function senderId(record: AgentCommunicationRecord): string {
  const from = record.participants.find((p) => p.role === 'from');
  return from?.id ?? 'unknown';
}

/** The two legal entry states for a turn (see the module doc comment's "Re-run entry point"). */
const ENTRY_STATES = ['ingested', 'awaiting_reprocess'] as const;
type EntryState = (typeof ENTRY_STATES)[number];

function isEntryState(status: AgentCommunicationRecord['status']): status is EntryState {
  return (ENTRY_STATES as readonly string[]).includes(status);
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
    accountsRepo,
    styleProfileRepo,
    styleEmbed,
  } = deps;
  const { commId, accountId } = input;
  const startedAt = clock();

  try {
    const record = await communicationsRepo.getById(commId);
    if (!record) {
      log.warn('Communication not found for agent turn — skipping', { commId });
      return { outcome: 'skipped', commId, reason: 'not_found' };
    }
    if (!isEntryState(record.status)) {
      // Idempotency: a redelivery of an already-processed communication is a no-op, not a re-run.
      // `ingested` is the first-ever turn; `awaiting_reprocess` is the `supplyContext` re-run entry
      // point (Task 6 review fix — see the module doc comment). Any other status means this turn
      // already ran (or is mid-flight) for this commId.
      log.info('Communication not in an entry state — skipping agent turn', {
        commId,
        status: record.status,
      });
      return { outcome: 'skipped', commId, reason: `status_${record.status}` };
    }
    const entryState: EntryState = record.status;

    const sessionId = record.threadKey;
    const actorId = senderId(record);

    const history = await conversationStore.loadSessionEvents(sessionId, actorId);
    const historyText = history.map((e) => `[${e.kind}] ${e.text}`);
    // Supplied context (Task 6 review fix) is appended as additional history, most-recent-supplied
    // last — same "oldest first" ordering `buildPrompt` (agent.ts) already assumes for `history`.
    for (const supplied of record.suppliedContext ?? []) {
      historyText.push(`[user_supplied_context] ${supplied}`);
    }

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

    // --- confidence + actionType GATE, in code (Task 5 constraint 3; slowking fix 2) ---------
    const route = routeRecommendation(
      recommendation.actionType,
      recommendation.confidence,
      confidenceThreshold,
    );
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
        from: entryState,
        to: 'needs_context',
        now,
      });
      await communicationsRepo.persistOutcome({
        commId,
        status: 'needs_context',
        recommendation,
        transitions,
      });
      await appendTurnIsolated(
        conversationStore,
        sessionId,
        actorId,
        record,
        { recommendation, route: 'needs_context' },
        { commId, log, metricsClient },
      );
      log.info(
        'Routed to needs_context (below confidence threshold, or escalate — no auto-reply)',
        {
          commId,
          actionType: recommendation.actionType,
          confidence: recommendation.confidence,
          threshold: confidenceThreshold,
        },
      );
      return {
        outcome: 'needs_context',
        commId,
        actionType: recommendation.actionType,
        confidence: recommendation.confidence,
      };
    }

    if (route === 'dismissed') {
      // fyi_no_reply at/above threshold (slowking fix 2): no reply is owed at all — dismiss
      // instead of fabricating a draft nobody asked for (state-machine.ts's documented
      // `recommended -> dismissed` "no reply needed — FYI, newsletters" outcome).
      const transitions = twoHopTransitions({
        commId,
        accountId,
        from: entryState,
        to: 'dismissed',
        now,
      });
      await communicationsRepo.persistOutcome({
        commId,
        status: 'dismissed',
        recommendation,
        transitions,
      });
      await appendTurnIsolated(
        conversationStore,
        sessionId,
        actorId,
        record,
        { recommendation, route: 'dismissed' },
        { commId, log, metricsClient },
      );
      log.info('Routed to dismissed (fyi_no_reply — no reply owed)', {
        commId,
        confidence: recommendation.confidence,
      });
      return {
        outcome: 'dismissed_no_reply_needed',
        commId,
        actionType: recommendation.actionType,
        confidence: recommendation.confidence,
      };
    }

    // --- draft (at/above threshold, and actionType warrants a reply) -------------------------
    // manageAsana (Task 7) is offered as a real callable tool alongside retrieveContext during the
    // draft step — the model decides whether follow-up tracking applies. It ONLY proposes (see
    // tools/manage-asana.ts's module doc: no network dependency, cannot perform a write), so binding
    // it here adds no write capability to the agent turn.
    //
    // Style (Task 10, design.md §6): `accountId -> userId` is resolved through `accountsRepo` (the
    // style-profiles table's key), then the style card + embedded sent-reply exemplars for that
    // user are looked up and injected. Both deps are OPTIONAL on `RunAgentTurnDeps` — when either
    // is unwired, `userId` resolves to `undefined` and `buildStyleInstructions` falls back to
    // `GENERIC_STYLE_CARD`, the exact pre-Task-10 behavior.
    const userId = accountsRepo ? await accountsRepo.getOwner(accountId) : undefined;
    const styleInstructions = await buildStyleInstructions(userId, {
      styleProfileRepo,
      retrievalIndex,
      accountId,
      messageText: record.body,
      embed: styleEmbed,
    });
    const draftOutput = await agentRunner.draft({
      sessionId,
      messageText: record.body,
      history: historyText,
      retrieveContextTool,
      actionType: recommendation.actionType,
      styleInstructions,
      manageAsanaTool: createManageAsanaTool(),
    });
    const draft: Draft = shapeDraft({ commId, accountId }, draftOutput);
    metricsClient.addMetric('DraftProduced', MetricUnit.Count, 1);
    // Task 10: distinguishes a style-matched draft (a real learned profile was applied) from the
    // generic v0 voice, without logging the style card/draft text itself (brief constraint 5: "NO
    // PII logs" — this is a pure count, no body content).
    if (styleInstructions !== GENERIC_STYLE_CARD) {
      metricsClient.addMetric('StyleDraftProduced', MetricUnit.Count, 1);
    }
    if (draftOutput.suggestedAsanaAction) {
      metricsClient.addMetric('AsanaActionSuggested', MetricUnit.Count, 1);
    }

    const transitions = twoHopTransitions({
      commId,
      accountId,
      from: entryState,
      to: 'drafted',
      now,
    });
    await communicationsRepo.persistOutcome({
      commId,
      status: 'drafted',
      recommendation,
      draft,
      transitions,
      suggestedAsanaAction: draftOutput.suggestedAsanaAction,
    });
    await appendTurnIsolated(
      conversationStore,
      sessionId,
      actorId,
      record,
      { recommendation, draft, route: 'drafted' },
      { commId, log, metricsClient },
    );

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
 * Builds the two transition records for one agent turn: `<from> → recommended` then
 * `recommended → <to>` (`drafted`, `needs_context`, or `dismissed` — slowking fix 2). `from` is the
 * turn's entry state — `ingested`
 * for the first-ever turn, `awaiting_reprocess` for a `supplyContext` re-run (Task 6 review fix; see
 * the module doc comment). Both hops are validated by `applyTransition` against the shared state
 * machine, so an illegal move throws (and the turn fails visibly) rather than persisting an
 * impossible state.
 */
function twoHopTransitions(params: {
  commId: string;
  accountId: string;
  from: EntryState;
  to: 'drafted' | 'needs_context' | 'dismissed';
  now: () => Date;
}): TransitionRecord[] {
  const { commId, accountId, from, to, now } = params;
  const first = applyTransition({
    commId,
    accountId,
    from,
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

/**
 * Appends the turn to AgentCore Memory, isolated the same way as `indexChunksIsolated` /
 * `triggerAgentIsolated` in the ingest processor (grep those for the shape): by the time this
 * runs, the recommendation/draft is already durably persisted via `persistOutcome` — that IS the
 * successful outcome of the turn. Memory is best-effort conversation history, not the source of
 * truth, so a throttled/failed AgentCore `CreateEvent` must never flip the turn to 'failed' and
 * must never trigger SQS redelivery: a redelivery would hit the idempotency guard (`record.status
 * !== 'ingested'`) and skip, permanently losing the retry without ever re-attempting the memory
 * write. Failure is a warn (ids only, no message body/PII) + a dedicated `MemoryAppendFailed`
 * metric instead.
 */
async function appendTurnIsolated(
  store: ConversationEventStore,
  sessionId: string,
  actorId: string,
  record: AgentCommunicationRecord,
  outcome: {
    recommendation: Recommendation;
    draft?: Draft;
    route: 'drafted' | 'needs_context' | 'dismissed';
  },
  deps: {
    commId: string;
    log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
    metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  },
): Promise<void> {
  try {
    await appendTurn(store, sessionId, actorId, record, outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn('Failed to append agent turn to conversation memory — turn still succeeded', {
      commId: deps.commId,
      error: message,
    });
    deps.metricsClient.addMetric('MemoryAppendFailed', MetricUnit.Count, 1);
  }
}

/** Appends the user turn + the assistant turn to memory with deterministic, id-derived tokens. */
async function appendTurn(
  store: ConversationEventStore,
  sessionId: string,
  actorId: string,
  record: AgentCommunicationRecord,
  outcome: {
    recommendation: Recommendation;
    draft?: Draft;
    route: 'drafted' | 'needs_context' | 'dismissed';
  },
): Promise<void> {
  const at = record.ts;
  // (slowking fix 2) `dismissed` (fyi_no_reply) and `needs_context` both have no draft — the
  // explicit `route` (not draft presence alone) picks the right summary so conversation history
  // never misreports a dismissed "no reply owed" outcome as "Routed to needs_context".
  const routeSummary =
    outcome.route === 'dismissed' ? 'Dismissed — no reply owed.' : 'Routed to needs_context.';
  const assistantSummary = outcome.draft
    ? `Recommended ${outcome.recommendation.actionType} (confidence ${outcome.recommendation.confidence}). Draft prepared.`
    : `Recommended ${outcome.recommendation.actionType} (confidence ${outcome.recommendation.confidence}). ${routeSummary}`;

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

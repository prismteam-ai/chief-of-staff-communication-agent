import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { RuntimeEnv } from '../env.js';
import { logger } from '../context.js';

/**
 * AgentCore Memory conversation history (kit skill `state-agentcore-memory.md`, Task 5 constraint
 * 5). This is the AI's turn history — user asks, assistant recommendation/draft — keyed by session
 * and actor. For this agent the identity is email-derived (design.md §5, `email-ingress.md`):
 *
 *   - `sessionId` = the communication's `threadKey`
 *   - `actorId`   = the sender (the participant with `role: 'from'`)
 *
 * It is deliberately separate from any Chat SDK state layer — this agent has no Chat SDK ingress
 * (see the ingress decision record), so the ONLY external state it keeps is this AI history plus the
 * communications table. The `ConversationEventStore` interface is what the orchestration calls; it
 * never imports the AWS SDK directly.
 */

/**
 * AgentCore constrains `sessionId`/`actorId` to `[a-zA-Z0-9][a-zA-Z0-9-_/]*(?::[a-zA-Z0-9-_/]+)*`
 * — an email actor (`demoalex775@gmail.com`) or a thread key with `#`/`@`/`.` violates it. This
 * maps any identifier deterministically into that charset by replacing every disallowed character
 * with `_` and prefixing an alphanumeric if needed, so a stable email/thread key yields a stable
 * AgentCore key (collisions are acceptable here — memory is per-session history, not an auth
 * boundary). The AgentCore constraint is confined to this adapter; the orchestration keeps the raw
 * semantic identity.
 */
export function sanitizeAgentCoreKey(raw: string): string {
  const replaced = raw.replace(/[^a-zA-Z0-9-_/]/g, '_');
  const trimmed = replaced.replace(/^[^a-zA-Z0-9]+/, '');
  const candidate = trimmed.length > 0 ? trimmed : `id_${replaced}`;
  // AgentCore keys have a max length; keep well under it.
  return candidate.slice(0, 200);
}

export type ConversationEventKind = 'user' | 'assistant';

export interface ConversationEvent {
  kind: ConversationEventKind;
  /** ISO-8601 timestamp of the turn. */
  at: string;
  /** Plain-text content of the turn (no PII beyond the message the user already sent us). */
  text: string;
}

export type AppendEventsOptions = {
  clientTokenFor: (event: ConversationEvent, ordinal: number) => string;
};

export interface ConversationEventStore {
  loadSessionEvents(sessionId: string, actorId: string): Promise<ConversationEvent[]>;
  appendEvents(
    sessionId: string,
    actorId: string,
    events: ConversationEvent[],
    options: AppendEventsOptions,
  ): Promise<void>;
}

// --- Event codec: ConversationEvent <-> AgentCore payload -------------------------------------

/**
 * AgentCore stores events as a list of payload blobs plus metadata. We encode one conversation turn
 * as a single conversational payload; the `kind` maps to AgentCore's conversational role
 * (`USER`/`ASSISTANT`) and the text is the content. Kept in a codec so the wire shape lives in one
 * place (kit skill key rule 5).
 */
type ConversationalRole = 'USER' | 'ASSISTANT';

function toRole(kind: ConversationEventKind): ConversationalRole {
  return kind === 'user' ? 'USER' : 'ASSISTANT';
}

function fromRole(role: string | undefined): ConversationEventKind {
  return role === 'ASSISTANT' ? 'assistant' : 'user';
}

interface AgentCoreConversationalPayload {
  conversational: { role: ConversationalRole; content: { text: string } };
}

function encodeEventPayload(event: ConversationEvent): AgentCoreConversationalPayload[] {
  return [{ conversational: { role: toRole(event.kind), content: { text: event.text } } }];
}

interface DecodableEvent {
  eventTimestamp?: Date | string | number;
  payload?: unknown;
}

function decodeEvent(raw: DecodableEvent): ConversationEvent | undefined {
  const payloadList = Array.isArray(raw.payload) ? raw.payload : [];
  for (const entry of payloadList) {
    if (typeof entry !== 'object' || entry === null) continue;
    const conversational = (entry as Record<string, unknown>).conversational;
    if (typeof conversational !== 'object' || conversational === null) continue;
    const c = conversational as Record<string, unknown>;
    const content = c.content;
    const text =
      typeof content === 'object' && content !== null
        ? ((content as Record<string, unknown>).text ?? '')
        : '';
    if (typeof text !== 'string') continue;
    const at =
      raw.eventTimestamp instanceof Date
        ? raw.eventTimestamp.toISOString()
        : new Date(raw.eventTimestamp ?? Date.now()).toISOString();
    return { kind: fromRole(typeof c.role === 'string' ? c.role : undefined), at, text };
  }
  return undefined;
}

function eventTime(event: ConversationEvent): number {
  const t = Date.parse(event.at);
  return Number.isNaN(t) ? 0 : t;
}

// --- AgentCore implementation ------------------------------------------------------------------

export class AgentCoreConversationEventStore implements ConversationEventStore {
  private readonly client: BedrockAgentCoreClient;
  private readonly memoryId: string;
  private readonly historyLimit: number;

  constructor(params: {
    memoryId: string;
    historyLimit: number;
    client?: BedrockAgentCoreClient;
    region?: string;
  }) {
    this.memoryId = params.memoryId;
    this.historyLimit = params.historyLimit;
    this.client = params.client ?? new BedrockAgentCoreClient({ region: params.region });
  }

  async loadSessionEvents(sessionId: string, actorId: string): Promise<ConversationEvent[]> {
    const safeSession = sanitizeAgentCoreKey(sessionId);
    const safeActor = sanitizeAgentCoreKey(actorId);
    const collected: ConversationEvent[] = [];
    let nextToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListEventsCommand({
          memoryId: this.memoryId,
          sessionId: safeSession,
          actorId: safeActor,
          includePayloads: true,
          maxResults: Math.min(100, this.historyLimit),
          nextToken,
        }),
      );

      for (const ev of page.events ?? []) {
        const decoded = decodeEvent(ev as DecodableEvent);
        if (decoded) collected.push(decoded);
      }

      nextToken = page.nextToken;
      if (collected.length >= this.historyLimit) break;
    } while (nextToken);

    return collected.sort((a, b) => eventTime(a) - eventTime(b)).slice(-this.historyLimit);
  }

  async appendEvents(
    sessionId: string,
    actorId: string,
    events: ConversationEvent[],
    options: AppendEventsOptions,
  ): Promise<void> {
    const safeSession = sanitizeAgentCoreKey(sessionId);
    const safeActor = sanitizeAgentCoreKey(actorId);
    let ordinal = 0;
    for (const event of events) {
      await this.client.send(
        new CreateEventCommand({
          memoryId: this.memoryId,
          actorId: safeActor,
          sessionId: safeSession,
          eventTimestamp: new Date(event.at),
          payload: encodeEventPayload(event),
          // Deterministic token derived from the provider message id + ordinal (kit skill key rule
          // 4) so a retried invocation or a duplicate delivery never double-writes the same turn.
          clientToken: options.clientTokenFor(event, ordinal),
        }),
      );
      ordinal += 1;
    }
  }
}

// --- Noop fallback -----------------------------------------------------------------------------

/**
 * Used when `AGENTCORE_MEMORY_ID` is unset (kit skill key rule 1: never fail because memory is
 * unconfigured). Loads nothing, stores nothing — the agent still runs, just statelessly.
 */
export class NoopConversationEventStore implements ConversationEventStore {
  async loadSessionEvents(_sessionId: string, _actorId: string): Promise<ConversationEvent[]> {
    return [];
  }
  async appendEvents(
    _sessionId: string,
    _actorId: string,
    _events: ConversationEvent[],
    _options: AppendEventsOptions,
  ): Promise<void> {
    // Intentionally does nothing.
  }
}

/**
 * Selects the real store when memory is configured, else the Noop. Built once at module scope by
 * the handler so warm containers reuse the client.
 */
export function createConversationEventStore(env: RuntimeEnv): ConversationEventStore {
  if (!env.agentcoreMemoryId) {
    logger.info('AGENTCORE_MEMORY_ID unset — using NoopConversationEventStore (stateless turns).');
    return new NoopConversationEventStore();
  }
  return new AgentCoreConversationEventStore({
    memoryId: env.agentcoreMemoryId,
    historyLimit: env.chatHistoryEventLimit,
    region: env.region,
  });
}

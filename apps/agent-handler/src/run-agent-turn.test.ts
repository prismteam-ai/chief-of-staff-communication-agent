import { describe, expect, it, vi } from 'vitest';
import { InMemoryRetrievalIndex } from '@chief-of-staff/rag';
import { canTransition, type NormalizedMessage } from '@chief-of-staff/shared';
import { runAgentTurn } from './run-agent-turn.js';
import type { AgentRunner, ClassifyInput, DraftInput } from './agent/agent.js';
import type {
  AgentCommunicationRecord,
  AgentCommunicationsRepo,
  PersistAgentOutcomeInput,
} from './communications-repo.js';
import { NoopConversationEventStore } from './memory/conversation-event-store.js';
import type { RecommendationOutput } from './tools/recommend-action.js';
import type { DraftOutput } from './tools/draft-reply.js';

// Silent logger/metrics stubs so tests never touch Powertools output.
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const metricsClient = { addMetric: vi.fn() };

function baseRecord(overrides: Partial<AgentCommunicationRecord> = {}): AgentCommunicationRecord {
  const message: NormalizedMessage = {
    schemaVersion: 1,
    channelType: 'gmail',
    accountId: 'acct-1',
    externalId: 'ext-1',
    threadKey: 'thread-1',
    participants: [{ id: 'sender@example.com', role: 'from' }],
    ts: '2026-07-16T00:00:00.000Z',
    body: 'Can you send me the Q3 numbers by Friday?',
    attachments: [],
  };
  return {
    ...message,
    commId: 'gmail#ext-1',
    status: 'ingested',
    ingestedAt: '2026-07-16T00:00:05.000Z',
    ...overrides,
  };
}

/** In-memory repo capturing the single persisted outcome. */
function fakeRepo(record: AgentCommunicationRecord | undefined): {
  repo: AgentCommunicationsRepo;
  persisted: PersistAgentOutcomeInput[];
} {
  const persisted: PersistAgentOutcomeInput[] = [];
  const repo: AgentCommunicationsRepo = {
    async getById() {
      return record;
    },
    async persistOutcome(input) {
      persisted.push(input);
    },
  };
  return { repo, persisted };
}

/** A fully-deterministic AgentRunner — no Bedrock, no network. */
function fakeRunner(rec: RecommendationOutput, draft: DraftOutput): AgentRunner {
  return {
    classify: async (_input: ClassifyInput) => rec,
    draft: async (_input: DraftInput) => draft,
  };
}

const commonDeps = {
  retrievalIndex: new InMemoryRetrievalIndex(),
  conversationStore: new NoopConversationEventStore(),
  log,
  metricsClient,
};

describe('runAgentTurn — high confidence: recommend + draft', () => {
  it('persists recommendation + draft, status drafted, with legal ingested→recommended→drafted transitions', async () => {
    const { repo, persisted } = fakeRepo(baseRecord());
    const runner = fakeRunner(
      { actionType: 'reply_needed', confidence: 0.9, rationale: 'Direct request.' },
      { body: 'Sure — attached are the Q3 numbers.', confidence: 0.88 },
    );

    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );

    expect(result.outcome).toBe('recommended_and_drafted');
    expect(persisted).toHaveLength(1);
    const outcome = persisted[0]!;
    expect(outcome.status).toBe('drafted');
    expect(outcome.recommendation.actionType).toBe('reply_needed');
    expect(outcome.draft?.body).toContain('Q3');

    // Transitions recorded this turn must all be legal per the shared state machine.
    expect(outcome.transitions).toHaveLength(2);
    for (const t of outcome.transitions) {
      expect(canTransition(t.from, t.to)).toBe(true);
    }
    expect(outcome.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'ingested->recommended',
      'recommended->drafted',
    ]);
  });
});

describe('runAgentTurn — low confidence: the gate routes to needs_context IN CODE', () => {
  it('persists needs_context with NO draft, even though the runner would draft', async () => {
    const { repo, persisted } = fakeRepo(baseRecord());
    const draftSpy = vi.fn(async () => ({ body: 'should not be produced', confidence: 0.5 }));
    const runner: AgentRunner = {
      classify: async () => ({ actionType: 'reply_needed', confidence: 0.3, rationale: 'Unsure.' }),
      draft: draftSpy,
    };

    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );

    expect(result.outcome).toBe('needs_context');
    // The draft step must NOT run below threshold — the decision is pure code, not the model.
    expect(draftSpy).not.toHaveBeenCalled();

    const outcome = persisted[0]!;
    expect(outcome.status).toBe('needs_context');
    expect(outcome.draft).toBeUndefined();
    expect(outcome.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'ingested->recommended',
      'recommended->needs_context',
    ]);
    for (const t of outcome.transitions) {
      expect(canTransition(t.from, t.to)).toBe(true);
    }
  });

  it('the routing decision needs no LLM call — a fixed confidence drives it deterministically', async () => {
    // Injecting a fixed confidence and a custom threshold proves the gate is pure code.
    const { repo, persisted } = fakeRepo(baseRecord());
    const runner = fakeRunner(
      { actionType: 'schedule', confidence: 0.65, rationale: 'Meeting request.' },
      { body: 'draft', confidence: 0.65 },
    );

    // Threshold above the fixed confidence → needs_context, with no model involvement in the choice.
    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo, confidenceThreshold: 0.7 },
    );
    expect(result.outcome).toBe('needs_context');
    expect(persisted[0]!.status).toBe('needs_context');
  });
});

describe('runAgentTurn — idempotency / skip paths', () => {
  it('skips a communication that is not in ingested state', async () => {
    const { repo, persisted } = fakeRepo(baseRecord({ status: 'drafted' }));
    const runner = fakeRunner(
      { actionType: 'reply_needed', confidence: 0.9, rationale: 'r' },
      { body: 'b', confidence: 0.9 },
    );
    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );
    expect(result.outcome).toBe('skipped');
    expect(persisted).toHaveLength(0);
  });

  it('skips a communication that does not exist', async () => {
    const { repo } = fakeRepo(undefined);
    const runner = fakeRunner(
      { actionType: 'reply_needed', confidence: 0.9, rationale: 'r' },
      { body: 'b', confidence: 0.9 },
    );
    const result = await runAgentTurn(
      { commId: 'gmail#missing', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );
    expect(result.outcome).toBe('skipped');
  });

  it('returns failed (and counts AgentTurnFailed) when the runner throws', async () => {
    const { repo } = fakeRepo(baseRecord());
    const runner: AgentRunner = {
      classify: async () => {
        throw new Error('bedrock exploded');
      },
      draft: async () => ({ body: 'x', confidence: 1 }),
    };
    metricsClient.addMetric.mockClear();
    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );
    expect(result.outcome).toBe('failed');
    expect(metricsClient.addMetric).toHaveBeenCalledWith('AgentTurnFailed', expect.anything(), 1);
  });
});

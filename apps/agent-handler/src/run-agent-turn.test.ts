import { describe, expect, it, vi } from 'vitest';
import { InMemoryRetrievalIndex, chunkSentReply } from '@chief-of-staff/rag';
import {
  canTransition,
  type NormalizedMessage,
  type StyleCard,
  type StyleProfileRecord,
} from '@chief-of-staff/shared';
import { runAgentTurn } from './run-agent-turn.js';
import type { AgentRunner, ClassifyInput, DraftInput } from './agent/agent.js';
import type { AgentAccountsRepo } from './accounts-repo.js';
import type { StyleProfileRepo } from './style/style-profile-repo.js';
import type {
  AgentCommunicationRecord,
  AgentCommunicationsRepo,
  PersistAgentOutcomeInput,
} from './communications-repo.js';
import { NoopConversationEventStore } from './memory/conversation-event-store.js';
import type { RecommendationOutput } from './tools/recommend-action.js';
import { GENERIC_STYLE_CARD } from './tools/style-profile.js';
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

describe('runAgentTurn — memory append is isolated from the turn outcome', () => {
  it('still returns recommended_and_drafted (with the outcome already persisted) when appendEvents throws', async () => {
    const { repo, persisted } = fakeRepo(baseRecord());
    const runner = fakeRunner(
      { actionType: 'reply_needed', confidence: 0.9, rationale: 'Direct request.' },
      { body: 'Sure — attached are the Q3 numbers.', confidence: 0.88 },
    );
    const throwingStore = {
      loadSessionEvents: async () => [],
      appendEvents: async () => {
        throw new Error('AgentCore throttled');
      },
    };
    log.warn.mockClear();
    log.error.mockClear();
    metricsClient.addMetric.mockClear();

    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      {
        ...commonDeps,
        conversationStore: throwingStore,
        agentRunner: runner,
        communicationsRepo: repo,
      },
    );

    expect(result.outcome).toBe('recommended_and_drafted');
    // The recommendation + draft were already durably persisted — that IS the successful outcome.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe('drafted');

    // Memory failure degrades: warn + MemoryAppendFailed, never AgentTurnFailed / error log.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('conversation memory'),
      expect.objectContaining({ commId: 'gmail#ext-1' }),
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(metricsClient.addMetric).toHaveBeenCalledWith(
      'MemoryAppendFailed',
      expect.anything(),
      1,
    );
    expect(metricsClient.addMetric).not.toHaveBeenCalledWith(
      'AgentTurnFailed',
      expect.anything(),
      1,
    );
  });

  it('still returns needs_context (with the outcome already persisted) when appendEvents throws', async () => {
    const { repo, persisted } = fakeRepo(baseRecord());
    const runner = fakeRunner(
      { actionType: 'reply_needed', confidence: 0.3, rationale: 'Unsure.' },
      { body: 'should not be produced', confidence: 0.5 },
    );
    const throwingStore = {
      loadSessionEvents: async () => [],
      appendEvents: async () => {
        throw new Error('AgentCore throttled');
      },
    };
    metricsClient.addMetric.mockClear();

    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      {
        ...commonDeps,
        conversationStore: throwingStore,
        agentRunner: runner,
        communicationsRepo: repo,
      },
    );

    expect(result.outcome).toBe('needs_context');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe('needs_context');
    expect(metricsClient.addMetric).toHaveBeenCalledWith(
      'MemoryAppendFailed',
      expect.anything(),
      1,
    );
    expect(metricsClient.addMetric).not.toHaveBeenCalledWith(
      'AgentTurnFailed',
      expect.anything(),
      1,
    );
  });
});

describe('runAgentTurn — idempotency / skip paths', () => {
  it('skips a communication that is not in an entry state (ingested or awaiting_reprocess)', async () => {
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

  it('also skips a needs_context communication directly (must go through awaiting_reprocess first)', async () => {
    const { repo, persisted } = fakeRepo(baseRecord({ status: 'needs_context' }));
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

describe('runAgentTurn — awaiting_reprocess re-run (Task 6 review fix: supplyContext no longer a dead-end)', () => {
  it('re-classifies from awaiting_reprocess and lands in drafted WITH a draft when confidence clears the gate', async () => {
    const { repo, persisted } = fakeRepo(
      baseRecord({
        status: 'awaiting_reprocess',
        suppliedContext: ['The renewal deadline is Friday.'],
      }),
    );
    const runner = fakeRunner(
      { actionType: 'reply_needed', confidence: 0.85, rationale: 'Deadline now known.' },
      { body: 'Confirmed — renewal will be handled by Friday.', confidence: 0.8 },
    );

    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );

    expect(result.outcome).toBe('recommended_and_drafted');
    const outcome = persisted[0]!;
    expect(outcome.status).toBe('drafted');
    expect(outcome.draft?.body).toContain('Friday');
    // First hop starts from awaiting_reprocess, not ingested — the re-run's real entry state.
    expect(outcome.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'awaiting_reprocess->recommended',
      'recommended->drafted',
    ]);
    for (const t of outcome.transitions) {
      expect(canTransition(t.from, t.to)).toBe(true);
    }
  });

  it('threads suppliedContext into the classify/draft prompt as additional history', async () => {
    const { repo } = fakeRepo(
      baseRecord({
        status: 'awaiting_reprocess',
        suppliedContext: ['The renewal deadline is Friday.'],
      }),
    );
    let classifyHistory: string[] = [];
    let draftHistory: string[] = [];
    const runner: AgentRunner = {
      classify: async (input) => {
        classifyHistory = input.history;
        return { actionType: 'reply_needed', confidence: 0.85, rationale: 'r' };
      },
      draft: async (input) => {
        draftHistory = input.history;
        return { body: 'b', confidence: 0.8 };
      },
    };

    await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );

    expect(classifyHistory.some((h) => h.includes('The renewal deadline is Friday.'))).toBe(true);
    expect(draftHistory.some((h) => h.includes('The renewal deadline is Friday.'))).toBe(true);
  });

  it('routes back to needs_context (still no draft) if the re-run is still below threshold', async () => {
    const { repo, persisted } = fakeRepo(
      baseRecord({ status: 'awaiting_reprocess', suppliedContext: ['Vague context.'] }),
    );
    const draftSpy = vi.fn(async () => ({ body: 'should not be produced', confidence: 0.4 }));
    const runner: AgentRunner = {
      classify: async () => ({
        actionType: 'reply_needed',
        confidence: 0.35,
        rationale: 'Still unsure.',
      }),
      draft: draftSpy,
    };

    const result = await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );

    expect(result.outcome).toBe('needs_context');
    expect(draftSpy).not.toHaveBeenCalled();
    const outcome = persisted[0]!;
    expect(outcome.status).toBe('needs_context');
    expect(outcome.draft).toBeUndefined();
    expect(outcome.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'awaiting_reprocess->recommended',
      'recommended->needs_context',
    ]);
    for (const t of outcome.transitions) {
      expect(canTransition(t.from, t.to)).toBe(true);
    }
  });
});

const FIXED_CARD: StyleCard = {
  tone: 'warm, direct, no filler',
  lengthBand: 'brief',
  signOff: 'Best,\nAlex',
  formality: 'professional but not stiff',
  greeting: 'Hi <first name>,',
};

function fakeAccountsRepo(map: Record<string, string>): AgentAccountsRepo {
  return { async getOwner(accountId) { return map[accountId]; } };
}

function fakeStyleProfileRepo(record?: StyleProfileRecord): StyleProfileRepo {
  return {
    async get(userId) {
      return record?.userId === userId ? record : undefined;
    },
    async put() {},
    async bumpSourceCount() {
      return false;
    },
  };
}

describe('runAgentTurn — style seam (Task 10): the draft prompt carries the user-specific voice', () => {
  it('passes the GENERIC style card to the draft step when accountsRepo/styleProfileRepo are not wired', async () => {
    const { repo } = fakeRepo(baseRecord());
    let capturedStyle = '';
    const runner: AgentRunner = {
      classify: async () => ({ actionType: 'reply_needed', confidence: 0.9, rationale: 'r' }),
      draft: async (input: DraftInput) => {
        capturedStyle = input.styleInstructions;
        return { body: 'draft body', confidence: 0.8 };
      },
    };

    await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo },
    );

    expect(capturedStyle).toBe(GENERIC_STYLE_CARD);
  });

  it('resolves accountId -> userId and injects the learned style card + exemplars into the draft prompt', async () => {
    const { repo } = fakeRepo(baseRecord({ accountId: 'acct-1' }));
    const accountsRepo = fakeAccountsRepo({ 'acct-1': 'user-alex' });
    const styleProfileRepo = fakeStyleProfileRepo({
      userId: 'user-alex',
      styleCard: FIXED_CARD,
      sourceCount: 10,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const retrievalIndex = new InMemoryRetrievalIndex();
    await retrievalIndex.indexChunks(
      chunkSentReply({
        sourceId: 'seed-1',
        body: 'Hi Priya,\n\nHappy to sign as is.\n\nBest,\nAlex',
        ts: '2026-07-01T00:00:00.000Z',
        accountId: 'acct-1',
      }).map((c) => ({ ...c, embedding: [1, 0, 0] })),
    );

    let capturedStyle = '';
    const runner: AgentRunner = {
      classify: async () => ({ actionType: 'reply_needed', confidence: 0.9, rationale: 'r' }),
      draft: async (input: DraftInput) => {
        capturedStyle = input.styleInstructions;
        return { body: 'draft body', confidence: 0.8 };
      },
    };

    await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-1' },
      {
        ...commonDeps,
        agentRunner: runner,
        communicationsRepo: repo,
        retrievalIndex,
        accountsRepo,
        styleProfileRepo,
        styleEmbed: async () => [1, 0, 0],
      },
    );

    expect(capturedStyle).not.toBe(GENERIC_STYLE_CARD);
    expect(capturedStyle).toContain('warm, direct, no filler');
    expect(capturedStyle).toContain('Best,\nAlex');
  });

  it('falls back to generic style when accountsRepo has no owner for this accountId', async () => {
    const { repo } = fakeRepo(baseRecord({ accountId: 'acct-unknown' }));
    const accountsRepo = fakeAccountsRepo({}); // no owner mapping
    const styleProfileRepo = fakeStyleProfileRepo();
    let capturedStyle = '';
    const runner: AgentRunner = {
      classify: async () => ({ actionType: 'reply_needed', confidence: 0.9, rationale: 'r' }),
      draft: async (input: DraftInput) => {
        capturedStyle = input.styleInstructions;
        return { body: 'draft body', confidence: 0.8 };
      },
    };

    await runAgentTurn(
      { commId: 'gmail#ext-1', accountId: 'acct-unknown' },
      { ...commonDeps, agentRunner: runner, communicationsRepo: repo, accountsRepo, styleProfileRepo },
    );

    expect(capturedStyle).toBe(GENERIC_STYLE_CARD);
  });
});

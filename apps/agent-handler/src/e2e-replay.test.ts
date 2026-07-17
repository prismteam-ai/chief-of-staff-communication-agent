import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRetrievalIndex } from '@chief-of-staff/rag';
import { NormalizedMessageSchema, commIdFor, type ActionType } from '@chief-of-staff/shared';
import { runAgentTurn } from './run-agent-turn.js';
import type { AgentRunner, ClassifyInput, DraftInput } from './agent/agent.js';
import type {
  AgentCommunicationRecord,
  AgentCommunicationsRepo,
  PersistAgentOutcomeInput,
} from './communications-repo.js';
import { NoopConversationEventStore } from './memory/conversation-event-store.js';
import type { RecommendationOutput } from './tools/recommend-action.js';

/**
 * End-to-end replay (Task 5 `fixtures/e2e/`): loads the inbound-message fixtures FROM DISK (not
 * inlined), replays each through `runAgentTurn` with a deterministic keyword-based fake model (no
 * Bedrock), and asserts the produced recommendation CLASS (action type) matches the expected class
 * in `cases.json` — never the exact wording. The low-confidence fixture must land in `needs_context`
 * via the in-code confidence gate. This complements the RAG golden-query replay.
 *
 * (slowking fix 2) The confidence gate now also branches on `actionType` (`routeRecommendation`):
 * `fyi_no_reply` at/above threshold routes to `dismissed` (no draft — no reply is owed), and
 * `escalate` at/above threshold routes to `needs_context` (no draft — must surface to a human). The
 * `fyi-newsletter.json`/`escalate-urgent.json` fixtures below assert exactly that, closing the gap
 * where every actionType used to get an auto-drafted "reply" once confidence cleared the threshold.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures/e2e');

interface Case {
  file: string;
  expectedActionType: ActionType;
  expectedOutcome: 'recommended_and_drafted' | 'needs_context' | 'dismissed_no_reply_needed';
  note: string;
}
interface CasesManifest {
  confidenceThreshold: number;
  cases: Case[];
}

function loadManifest(): CasesManifest {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'cases.json'), 'utf8')) as CasesManifest;
}

function loadFixtureRecord(file: string): AgentCommunicationRecord {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
  // Validate the fixture against the real NormalizedMessage schema so a malformed fixture fails
  // loudly here rather than silently mis-driving the agent.
  const message = NormalizedMessageSchema.parse(raw);
  return {
    ...message,
    commId: commIdFor(message.channelType, message.externalId),
    status: 'ingested',
    ingestedAt: message.ts,
  };
}

/**
 * A deterministic, keyword-driven classifier standing in for the LLM — the SAME classification
 * contract the real model produces (`RecommendationOutput`), so the orchestration path under test is
 * identical; only the "brain" is swapped for a fixed function. Confidence is intentionally low for
 * the ambiguous fixture so the in-code gate routes it to needs_context.
 */
function classifyByKeywords(text: string): RecommendationOutput {
  const t = text.toLowerCase();
  if (/urgent|critical|incident|escalate|immediately/.test(t)) {
    return { actionType: 'escalate', confidence: 0.95, rationale: 'Urgent, high-stakes incident.' };
  }
  if (/delegate|hand-?off|belongs to|accounts payable|finance team/.test(t)) {
    return { actionType: 'delegate', confidence: 0.9, rationale: 'Work belongs to another team.' };
  }
  if (/meeting|calendar|set up a .*meeting|are you free|schedule/.test(t)) {
    return { actionType: 'schedule', confidence: 0.9, rationale: 'A scheduling request.' };
  }
  if (/newsletter|digest|unsubscribe|no action required|automated/.test(t)) {
    return {
      actionType: 'fyi_no_reply',
      confidence: 0.9,
      rationale: 'Informational, no reply owed.',
    };
  }
  if (/\bquestion\b|please reply|can you confirm|need to update|let me know/.test(t)) {
    return {
      actionType: 'reply_needed',
      confidence: 0.9,
      rationale: 'A direct question expecting a reply.',
    };
  }
  // Ambiguous / low-signal → low confidence, so the gate routes to needs_context in code.
  return {
    actionType: 'needs_context',
    confidence: 0.2,
    rationale: 'Too little signal to classify.',
  };
}

function keywordRunner(): AgentRunner {
  return {
    classify: async (input: ClassifyInput) => classifyByKeywords(input.messageText),
    draft: async (_input: DraftInput) => ({
      body: 'Thanks for your message — I will follow up shortly.',
      confidence: 0.85,
    }),
  };
}

function fakeRepo(record: AgentCommunicationRecord): {
  repo: AgentCommunicationsRepo;
  persisted: PersistAgentOutcomeInput[];
} {
  const persisted: PersistAgentOutcomeInput[] = [];
  return {
    persisted,
    repo: {
      async getById() {
        return record;
      },
      async persistOutcome(input) {
        persisted.push(input);
      },
    },
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const metricsClient = { addMetric: vi.fn() };

describe('e2e fixture replay — inbound message classifies to the expected action class', () => {
  const manifest = loadManifest();

  for (const testCase of manifest.cases) {
    it(`${testCase.file} → ${testCase.expectedActionType} (${testCase.note})`, async () => {
      const record = loadFixtureRecord(testCase.file);
      const { repo, persisted } = fakeRepo(record);

      const result = await runAgentTurn(
        { commId: record.commId, accountId: record.accountId },
        {
          communicationsRepo: repo,
          retrievalIndex: new InMemoryRetrievalIndex(),
          agentRunner: keywordRunner(),
          conversationStore: new NoopConversationEventStore(),
          confidenceThreshold: manifest.confidenceThreshold,
          log,
          metricsClient,
        },
      );

      expect(result.outcome).toBe(testCase.expectedOutcome);
      expect(persisted).toHaveLength(1);
      const outcome = persisted[0]!;

      // Assert the CLASS, not the wording.
      expect(outcome.recommendation.actionType).toBe(testCase.expectedActionType);

      if (testCase.expectedOutcome === 'needs_context') {
        expect(outcome.status).toBe('needs_context');
        expect(outcome.draft).toBeUndefined();
      } else if (testCase.expectedOutcome === 'dismissed_no_reply_needed') {
        expect(outcome.status).toBe('dismissed');
        expect(outcome.draft).toBeUndefined();
      } else {
        expect(outcome.status).toBe('drafted');
        expect(outcome.draft).toBeDefined();
      }
    });
  }

  it('loads all six declared fixtures from disk (not inlined)', () => {
    expect(manifest.cases).toHaveLength(6);
    for (const c of manifest.cases) {
      expect(() => loadFixtureRecord(c.file)).not.toThrow();
    }
  });
});

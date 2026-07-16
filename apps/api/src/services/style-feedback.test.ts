import { describe, expect, it } from 'vitest';
import { InMemoryRetrievalIndex } from '@chief-of-staff/rag';
import type { StyleProfileRecord } from '@chief-of-staff/shared';
import type { StyleProfileRepo } from '@chief-of-staff/agent-handler/style';
import { createStyleFeedbackHook } from './style-feedback.js';

function fakeStyleProfileRepo(initial?: StyleProfileRecord): {
  repo: StyleProfileRepo;
  bumpCalls: string[];
  store: Map<string, StyleProfileRecord>;
} {
  const store = new Map<string, StyleProfileRecord>();
  if (initial) store.set(initial.userId, initial);
  const bumpCalls: string[] = [];
  return {
    store,
    bumpCalls,
    repo: {
      async get(userId) {
        return store.get(userId);
      },
      async put(record) {
        store.set(record.userId, record);
      },
      async bumpSourceCount(userId) {
        bumpCalls.push(userId);
        const existing = store.get(userId);
        if (!existing) return false;
        store.set(userId, {
          ...existing,
          sourceCount: existing.sourceCount + 1,
          updatedAt: '2026-07-16T00:00:00.000Z',
        });
        return true;
      },
    },
  };
}

const noopEmbed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

describe('createStyleFeedbackHook — recordSentReply', () => {
  it('indexes the final sent body as a sent_style exemplar, account-scoped', async () => {
    const { repo } = fakeStyleProfileRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();
    const hook = createStyleFeedbackHook({
      styleProfileRepo: repo,
      retrievalIndex,
      embed: noopEmbed,
    });

    await hook.recordSentReply({
      userId: 'user-alex',
      accountId: 'acct-alex',
      commId: 'gmail#abc123',
      body: 'Confirmed — thanks for flagging that early.\n\nBest,\nAlex',
      recipients: ['renee@harborline-partners.com'],
      ts: '2026-07-16T12:00:00.000Z',
    });

    const chunks = retrievalIndex.all();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata.sourceType).toBe('sent_style');
    expect(chunks[0]!.metadata.accountId).toBe('acct-alex');
    expect(chunks[0]!.textForEmbedding).toContain('Confirmed');
  });

  it('never leaks one account exemplar into another account search (permission boundary)', async () => {
    const { repo } = fakeStyleProfileRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();
    const hook = createStyleFeedbackHook({
      styleProfileRepo: repo,
      retrievalIndex,
      embed: noopEmbed,
    });

    await hook.recordSentReply({
      userId: 'user-alex',
      accountId: 'acct-alex',
      commId: 'gmail#abc123',
      body: 'Alex reply body',
      recipients: [],
      ts: '2026-07-16T12:00:00.000Z',
    });
    await hook.recordSentReply({
      userId: 'user-bea',
      accountId: 'acct-bea',
      commId: 'gmail#def456',
      body: 'Bea reply body',
      recipients: [],
      ts: '2026-07-16T12:00:00.000Z',
    });

    const aliceHits = await retrievalIndex.search([0.1, 0.2, 0.3], 'reply', {
      accountId: 'acct-alex',
      topK: 10,
      filters: { sourceType: 'sent_style' },
    });
    expect(aliceHits).toHaveLength(1);
    expect(aliceHits[0]!.textForContext).toContain('Alex');
  });

  it('bumps the style profile sourceCount when a profile already exists', async () => {
    const { repo, bumpCalls, store } = fakeStyleProfileRepo({
      userId: 'user-alex',
      styleCard: {
        tone: 't',
        lengthBand: 'brief',
        signOff: 'Best,\nAlex',
        formality: 'f',
        greeting: 'g',
      },
      sourceCount: 5,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const retrievalIndex = new InMemoryRetrievalIndex();
    const hook = createStyleFeedbackHook({
      styleProfileRepo: repo,
      retrievalIndex,
      embed: noopEmbed,
    });

    await hook.recordSentReply({
      userId: 'user-alex',
      accountId: 'acct-alex',
      commId: 'gmail#abc123',
      body: 'A reply',
      recipients: [],
      ts: '2026-07-16T12:00:00.000Z',
    });

    expect(bumpCalls).toEqual(['user-alex']);
    expect(store.get('user-alex')?.sourceCount).toBe(6);
  });

  it('is a no-op on sourceCount when no profile exists yet (still indexes the exemplar)', async () => {
    const { repo, bumpCalls } = fakeStyleProfileRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();
    const hook = createStyleFeedbackHook({
      styleProfileRepo: repo,
      retrievalIndex,
      embed: noopEmbed,
    });

    await hook.recordSentReply({
      userId: 'user-new',
      accountId: 'acct-new',
      commId: 'gmail#xyz',
      body: 'First ever sent reply',
      recipients: [],
      ts: '2026-07-16T12:00:00.000Z',
    });

    expect(bumpCalls).toEqual(['user-new']);
    expect(retrievalIndex.all()).toHaveLength(1);
  });

  it('is idempotent: recording the same commId+body twice upserts one exemplar, not two', async () => {
    const { repo } = fakeStyleProfileRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();
    const hook = createStyleFeedbackHook({
      styleProfileRepo: repo,
      retrievalIndex,
      embed: noopEmbed,
    });

    const input = {
      userId: 'user-alex',
      accountId: 'acct-alex',
      commId: 'gmail#abc123',
      body: 'A retried approval sends the identical final body',
      recipients: [],
      ts: '2026-07-16T12:00:00.000Z',
    };
    await hook.recordSentReply(input);
    await hook.recordSentReply(input); // simulates a retried approveDraft call

    expect(retrievalIndex.all()).toHaveLength(1);
  });
});

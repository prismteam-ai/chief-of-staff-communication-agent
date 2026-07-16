import { describe, expect, it, vi } from 'vitest';
import { InMemoryRetrievalIndex } from '@chief-of-staff/rag';
import type { StyleCard, StyleProfileRecord } from '@chief-of-staff/shared';
import { buildStyleProfile } from './build-style-profile.js';
import type { StyleCardExtractor, SentReplySample } from './style-card.js';
import type { StyleProfileRepo } from './style-profile-repo.js';

const log = { info: vi.fn(), warn: vi.fn() };
const metricsClient = { addMetric: vi.fn() };

const FIXED_CARD: StyleCard = {
  tone: 'warm, direct, no filler',
  lengthBand: 'brief',
  signOff: 'Best,\nAlex',
  formality: 'professional but not stiff',
  greeting: 'Hi <first name>,',
};

/** A fully-deterministic extractor — no Bedrock. Captures the samples it was called with so tests
 * can assert the fixture sent replies actually reached the extraction call. */
function fakeExtractor(card: StyleCard = FIXED_CARD): {
  extractor: StyleCardExtractor;
  calls: SentReplySample[][];
} {
  const calls: SentReplySample[][] = [];
  return {
    extractor: {
      async extract(samples) {
        calls.push(samples);
        return card;
      },
    },
    calls,
  };
}

/** In-memory style-profiles repo double. */
function fakeRepo(): { repo: StyleProfileRepo; store: Map<string, StyleProfileRecord> } {
  const store = new Map<string, StyleProfileRecord>();
  return {
    store,
    repo: {
      async get(userId) {
        return store.get(userId);
      },
      async put(record) {
        store.set(record.userId, record);
      },
      async bumpSourceCount(userId) {
        const existing = store.get(userId);
        if (!existing) return false;
        store.set(userId, {
          ...existing,
          sourceCount: existing.sourceCount + 1,
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
    },
  };
}

const fixtureSentReplies = [
  {
    sourceId: 'seed-1',
    body: 'Hi Priya,\n\nThanks for sending this over. Happy to sign as is.\n\nBest,\nAlex',
    ts: '2026-07-01T10:00:00.000Z',
    recipient: 'priya@northwind-consulting.com',
  },
  {
    sourceId: 'seed-2',
    body: 'Hi Daniel,\n\nGreat to connect — looping in finance now.\n\nBest,\nAlex',
    ts: '2026-07-02T10:00:00.000Z',
    recipient: 'daniel@meridian-partners.io',
  },
];

const noopEmbed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

describe('buildStyleProfile', () => {
  it('extracts a style card from the sent-reply sample and persists it to the style-profiles repo', async () => {
    const { extractor, calls } = fakeExtractor();
    const { repo, store } = fakeRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();

    const result = await buildStyleProfile(
      { userId: 'user-alex', accountId: 'acct-alex', sentReplies: fixtureSentReplies },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );

    expect(result.styleCard).toEqual(FIXED_CARD);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]![0]!.body).toContain('Priya');

    const persisted = store.get('user-alex');
    expect(persisted?.styleCard).toEqual(FIXED_CARD);
    expect(persisted?.sourceCount).toBe(2);
  });

  it('indexes every sent reply as an account-scoped sent_style exemplar', async () => {
    const { extractor } = fakeExtractor();
    const { repo } = fakeRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();

    const result = await buildStyleProfile(
      { userId: 'user-alex', accountId: 'acct-alex', sentReplies: fixtureSentReplies },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );

    expect(result.exemplarsIndexed).toBe(2);
    const allChunks = retrievalIndex.all();
    expect(allChunks).toHaveLength(2);
    for (const chunk of allChunks) {
      expect(chunk.metadata.sourceType).toBe('sent_style');
      expect(chunk.metadata.accountId).toBe('acct-alex');
    }
  });

  it('never leaks one account exemplars into another account search (permission boundary)', async () => {
    const { extractor } = fakeExtractor();
    const { repo } = fakeRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();

    await buildStyleProfile(
      { userId: 'user-alex', accountId: 'acct-alex', sentReplies: fixtureSentReplies },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );
    await buildStyleProfile(
      {
        userId: 'user-bea',
        accountId: 'acct-bea',
        sentReplies: [
          {
            sourceId: 'seed-1',
            body: 'Hey — sounds good, will do. — B',
            ts: '2026-07-03T10:00:00.000Z',
          },
        ],
      },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );

    const bScoped = await retrievalIndex.search([0.1, 0.2, 0.3], 'anything', {
      accountId: 'acct-bea',
      topK: 10,
      filters: { sourceType: 'sent_style' },
    });
    expect(bScoped).toHaveLength(1);
    expect(bScoped[0]!.metadata.accountId).toBe('acct-bea');

    const aScoped = await retrievalIndex.search([0.1, 0.2, 0.3], 'anything', {
      accountId: 'acct-alex',
      topK: 10,
      filters: { sourceType: 'sent_style' },
    });
    expect(aScoped).toHaveLength(2);
    expect(aScoped.every((h) => h.metadata.accountId === 'acct-alex')).toBe(true);
  });

  it('is idempotent: re-running upserts the same exemplar chunks rather than duplicating them', async () => {
    const { extractor } = fakeExtractor();
    const { repo } = fakeRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();

    await buildStyleProfile(
      { userId: 'user-alex', accountId: 'acct-alex', sentReplies: fixtureSentReplies },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );
    await buildStyleProfile(
      { userId: 'user-alex', accountId: 'acct-alex', sentReplies: fixtureSentReplies },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );

    expect(retrievalIndex.all()).toHaveLength(2); // same content -> same deterministic chunk ids -> upsert, not duplicate
  });

  it('caps the extraction sample at MAX_STYLE_SAMPLES even with a larger sent-history corpus', async () => {
    const { extractor, calls } = fakeExtractor();
    const { repo } = fakeRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();
    const manyReplies = Array.from({ length: 30 }, (_, i) => ({
      sourceId: `seed-${i}`,
      body: `Reply number ${i}. Best,\nAlex`,
      ts: '2026-07-01T10:00:00.000Z',
    }));

    const result = await buildStyleProfile(
      { userId: 'user-alex', accountId: 'acct-alex', sentReplies: manyReplies },
      { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
    );

    expect(calls[0]).toHaveLength(20);
    expect(result.exemplarsIndexed).toBe(30); // ALL replies still indexed as exemplars, only extraction is sampled
  });

  it('throws when given no sent replies rather than persisting an empty profile', async () => {
    const { extractor } = fakeExtractor();
    const { repo } = fakeRepo();
    const retrievalIndex = new InMemoryRetrievalIndex();

    await expect(
      buildStyleProfile(
        { userId: 'user-alex', accountId: 'acct-alex', sentReplies: [] },
        { extractor, styleProfileRepo: repo, retrievalIndex, log, metricsClient, embed: noopEmbed },
      ),
    ).rejects.toThrow();
  });
});

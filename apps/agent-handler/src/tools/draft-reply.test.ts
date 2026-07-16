import { describe, expect, it } from 'vitest';
import { DraftSchema, type StyleCard, type StyleProfileRecord } from '@chief-of-staff/shared';
import { InMemoryRetrievalIndex, chunkSentReply } from '@chief-of-staff/rag';
import { shapeDraft, buildStyleInstructions } from './draft-reply.js';
import { GENERIC_STYLE_CARD } from './style-profile.js';
import type { StyleProfileRepo } from '../style/style-profile-repo.js';

const ctx = { commId: 'gmail#abc', accountId: 'acct-1' };

describe('shapeDraft — shapes a model output into the shared Draft', () => {
  it('produces a Draft that validates against the shared schema', () => {
    const draft = shapeDraft(ctx, {
      body: 'Thanks for reaching out — happy to help. Best, Alex',
      confidence: 0.77,
    });
    expect(DraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.commId).toBe('gmail#abc');
    expect(draft.body).toContain('Thanks');
  });

  it('rejects an out-of-range confidence', () => {
    expect(() => shapeDraft(ctx, { body: 'hi', confidence: -0.2 })).toThrow();
  });
});

const FIXED_CARD: StyleCard = {
  tone: 'warm, direct, no filler',
  lengthBand: 'brief',
  signOff: 'Best,\nAlex',
  formality: 'professional but not stiff',
  greeting: 'Hi <first name>,',
};

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

describe('buildStyleInstructions — exercises the style seam (Task 10 fills it in)', () => {
  it('falls back to the generic v0 style card when no userId is given', async () => {
    await expect(buildStyleInstructions(undefined, {})).resolves.toBe(GENERIC_STYLE_CARD);
  });

  it('falls back to the generic v0 style card when no profile exists for the user', async () => {
    const styleProfileRepo = fakeStyleProfileRepo(undefined);
    await expect(buildStyleInstructions('user-1', { styleProfileRepo })).resolves.toBe(
      GENERIC_STYLE_CARD,
    );
  });

  it('falls back to the generic v0 style card when style deps are not wired at all (pre-Task-10 call sites)', async () => {
    await expect(buildStyleInstructions('user-1', {})).resolves.toBe(GENERIC_STYLE_CARD);
  });

  it('injects the real style card once a profile exists', async () => {
    const record: StyleProfileRecord = {
      userId: 'user-1',
      styleCard: FIXED_CARD,
      sourceCount: 5,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const styleProfileRepo = fakeStyleProfileRepo(record);

    const instructions = await buildStyleInstructions('user-1', { styleProfileRepo });
    expect(instructions).toContain('warm, direct, no filler');
    expect(instructions).toContain('Best,\nAlex');
    expect(instructions).not.toBe(GENERIC_STYLE_CARD);
  });

  it('appends retrieved exemplars, account-scoped, when a retrieval index + accountId are wired', async () => {
    const record: StyleProfileRecord = {
      userId: 'user-1',
      styleCard: FIXED_CARD,
      sourceCount: 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const styleProfileRepo = fakeStyleProfileRepo(record);
    const retrievalIndex = new InMemoryRetrievalIndex();
    await retrievalIndex.indexChunks(
      chunkSentReply({
        sourceId: 'seed-1',
        body: 'Hi Priya,\n\nHappy to sign as is.\n\nBest,\nAlex',
        ts: '2026-07-01T00:00:00.000Z',
        accountId: 'acct-1',
      }).map((c) => ({ ...c, embedding: [1, 0, 0] })),
    );

    const instructions = await buildStyleInstructions('user-1', {
      styleProfileRepo,
      retrievalIndex,
      accountId: 'acct-1',
      messageText: 'renewal terms',
      embed: async () => [1, 0, 0],
    });

    expect(instructions).toContain('Happy to sign as is');
  });

  it('never leaks another account exemplar into the rendered instructions', async () => {
    const record: StyleProfileRecord = {
      userId: 'user-1',
      styleCard: FIXED_CARD,
      sourceCount: 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const styleProfileRepo = fakeStyleProfileRepo(record);
    const retrievalIndex = new InMemoryRetrievalIndex();
    await retrievalIndex.indexChunks(
      chunkSentReply({
        sourceId: 'seed-1',
        body: 'This belongs to a DIFFERENT account entirely.',
        ts: '2026-07-01T00:00:00.000Z',
        accountId: 'acct-OTHER',
      }).map((c) => ({ ...c, embedding: [1, 0, 0] })),
    );

    const instructions = await buildStyleInstructions('user-1', {
      styleProfileRepo,
      retrievalIndex,
      accountId: 'acct-1', // querying account 1, exemplar belongs to acct-OTHER
      messageText: 'anything',
      embed: async () => [1, 0, 0],
    });

    expect(instructions).not.toContain('DIFFERENT account');
  });
});

import { describe, expect, it } from 'vitest';
import { InMemoryRetrievalIndex } from './retrieval-index.js';
import type { EmbeddedChunk } from './corpus.js';

/** A tiny embed stub: maps a string to a fixed vector so tests are deterministic. */
function vec(...values: number[]): number[] {
  return values;
}

function chunk(overrides: Partial<EmbeddedChunk> & { chunkId: string; accountId: string }): EmbeddedChunk {
  const { accountId, chunkId, ...rest } = overrides;
  return {
    chunkId,
    sourceId: `src-${chunkId}`,
    chunkIndex: 0,
    textForEmbedding: 'default text',
    textForContext: 'default context',
    embedding: vec(1, 0, 0),
    ...rest,
    metadata: {
      channel: 'gmail',
      accountId,
      participants: [],
      ts: '2026-07-10T00:00:00.000Z',
      sourceType: 'communication',
      ...overrides.metadata,
    },
  };
}

describe('InMemoryRetrievalIndex', () => {
  it('indexChunks then search returns matching chunks for the querying account', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'c1', accountId: 'acct_A', textForEmbedding: 'meridian contract review', embedding: vec(1, 0, 0) }),
    ]);

    const results = await index.search(vec(1, 0, 0), 'meridian contract', {
      accountId: 'acct_A',
      topK: 5,
    });

    expect(results.map((r) => r.chunkId)).toContain('c1');
    expect(results[0]!.textForContext).toBeDefined();
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('SECURITY: never returns another account\'s chunk even when it is the closest vector match', async () => {
    const index = new InMemoryRetrievalIndex();
    // acct_B's chunk is an EXACT vector + text match for the query; acct_A's is a weak match.
    await index.indexChunks([
      chunk({ chunkId: 'b_exact', accountId: 'acct_B', textForEmbedding: 'the exact secret deal terms', embedding: vec(1, 0, 0) }),
      chunk({ chunkId: 'a_weak', accountId: 'acct_A', textForEmbedding: 'unrelated note', embedding: vec(0, 0, 1) }),
    ]);

    const results = await index.search(vec(1, 0, 0), 'the exact secret deal terms', {
      accountId: 'acct_A',
      topK: 10,
    });

    const ids = results.map((r) => r.chunkId);
    expect(ids).not.toContain('b_exact');
    expect(ids).toEqual(['a_weak']); // only acct_A's chunk, despite being the worse match
  });

  it('SECURITY: an account with no chunks gets an empty result, not a cross-account leak', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([chunk({ chunkId: 'b1', accountId: 'acct_B', embedding: vec(1, 0, 0) })]);

    const results = await index.search(vec(1, 0, 0), 'anything', { accountId: 'acct_A', topK: 10 });
    expect(results).toEqual([]);
  });

  it('applies a participant metadata filter on top of the account filter', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'p1', accountId: 'acct_A', embedding: vec(1, 0, 0), metadata: { channel: 'gmail', accountId: 'acct_A', participants: ['sam@vendor.io'], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication' } }),
      chunk({ chunkId: 'p2', accountId: 'acct_A', embedding: vec(1, 0, 0), metadata: { channel: 'gmail', accountId: 'acct_A', participants: ['dana@other.com'], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication' } }),
    ]);

    const results = await index.search(vec(1, 0, 0), 'x', {
      accountId: 'acct_A',
      topK: 10,
      filters: { participant: 'sam@vendor.io' },
    });

    expect(results.map((r) => r.chunkId)).toEqual(['p1']);
  });

  it('respects topK', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'k1', accountId: 'acct_A', embedding: vec(1, 0, 0) }),
      chunk({ chunkId: 'k2', accountId: 'acct_A', embedding: vec(0.9, 0.1, 0) }),
      chunk({ chunkId: 'k3', accountId: 'acct_A', embedding: vec(0.8, 0.2, 0) }),
    ]);

    const results = await index.search(vec(1, 0, 0), 'x', { accountId: 'acct_A', topK: 2 });
    expect(results).toHaveLength(2);
  });

  it('re-indexing the same chunk id upserts rather than duplicating', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([chunk({ chunkId: 'u1', accountId: 'acct_A', textForContext: 'v1', embedding: vec(1, 0, 0) })]);
    await index.indexChunks([chunk({ chunkId: 'u1', accountId: 'acct_A', textForContext: 'v2', embedding: vec(1, 0, 0) })]);

    const results = await index.search(vec(1, 0, 0), 'x', { accountId: 'acct_A', topK: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]!.textForContext).toBe('v2');
  });
});

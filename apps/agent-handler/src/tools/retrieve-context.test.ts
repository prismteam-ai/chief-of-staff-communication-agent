import { describe, expect, it } from 'vitest';
import { InMemoryRetrievalIndex, type EmbeddedChunk } from '@chief-of-staff/rag';
import { runRetrieveContext, RETRIEVE_CONTEXT_MAX_TOP_K } from './retrieve-context.js';

function chunk(accountId: string, id: string, text: string): EmbeddedChunk {
  return {
    chunkId: `${id}#0#hash`,
    sourceId: id,
    chunkIndex: 0,
    textForEmbedding: text,
    textForContext: text,
    metadata: {
      channel: 'gmail',
      accountId,
      participants: [],
      ts: '2026-07-16T00:00:00.000Z',
      sourceType: 'communication',
    },
    embedding: [1, 0, 0],
  };
}

// A deterministic fake embedder — no Bedrock. The vector is irrelevant to the account-scoping
// assertion (the account filter is applied before scoring), so a constant vector is fine.
const fakeEmbed = async () => [1, 0, 0];

describe('runRetrieveContext — account scoping is the permission boundary', () => {
  it('never returns another account’s chunks', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk('acct-A', 'a-1', 'project alpha status update'),
      chunk('acct-B', 'b-1', 'project alpha status update'), // same text, different account
    ]);

    const resultA = await runRetrieveContext(
      { retrievalIndex: index, accountId: 'acct-A', embed: fakeEmbed },
      { query: 'project alpha status' },
    );

    expect(resultA.hits.length).toBeGreaterThan(0);
    // Every returned hit must belong to account A — B's chunk must never appear.
    expect(resultA.hits.every((h) => h.sourceId.startsWith('a-'))).toBe(true);
    expect(resultA.hits.some((h) => h.sourceId === 'b-1')).toBe(false);
  });

  it('returns no hits (not an error) for a blank query', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([chunk('acct-A', 'a-1', 'anything')]);
    const result = await runRetrieveContext(
      { retrievalIndex: index, accountId: 'acct-A', embed: fakeEmbed },
      { query: '   ' },
    );
    expect(result.hits).toEqual([]);
  });

  it('clamps topK to the max even if a larger value is requested', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks(
      Array.from({ length: 20 }, (_, i) => chunk('acct-A', `a-${i}`, `doc ${i} shared term`)),
    );
    const result = await runRetrieveContext(
      { retrievalIndex: index, accountId: 'acct-A', embed: fakeEmbed },
      { query: 'shared term', topK: 999 },
    );
    expect(result.hits.length).toBeLessThanOrEqual(RETRIEVE_CONTEXT_MAX_TOP_K);
  });
});

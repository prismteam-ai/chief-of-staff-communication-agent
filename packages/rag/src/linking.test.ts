import { describe, expect, it } from 'vitest';
import { InMemoryRetrievalIndex } from './retrieval-index.js';
import { findRelated } from './linking.js';
import type { EmbeddedChunk } from './corpus.js';

function chunk(overrides: Partial<EmbeddedChunk> & { chunkId: string; accountId: string }): EmbeddedChunk {
  const { accountId, chunkId, ...rest } = overrides;
  return {
    chunkId,
    sourceId: `src-${chunkId}`,
    chunkIndex: 0,
    textForEmbedding: 'default text',
    textForContext: 'default context',
    embedding: [0, 0, 0],
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

/**
 * Cross-channel linking tests (design.md §4 "not embeddings alone"; README L28). Every fixture
 * chunk here uses a distinct, unrelated embedding vector — `findRelated` must still surface them
 * together purely because they share a metadata dimension, proving the linking is filter-driven,
 * not similarity-driven.
 */
describe('findRelated', () => {
  it('links chunks across channels that share a topic, ignoring embedding distance entirely', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'gmail-1', accountId: 'acct_A', embedding: [1, 0, 0], metadata: { channel: 'gmail', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication', topic: 'meridian-contract' } }),
      chunk({ chunkId: 'sms-1', accountId: 'acct_A', embedding: [0, 1, 0], metadata: { channel: 'sms', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication', topic: 'meridian-contract' } }),
      chunk({ chunkId: 'unrelated', accountId: 'acct_A', embedding: [0, 0, 1], metadata: { channel: 'gmail', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication', topic: 'other-topic' } }),
    ]);

    const related = await findRelated(index, 'acct_A', { topic: 'meridian-contract' });

    expect(related.map((r) => r.chunkId).sort()).toEqual(['gmail-1', 'sms-1']);
  });

  it('links by participant across source types (communication + asana)', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'msg-1', accountId: 'acct_A', metadata: { channel: 'gmail', accountId: 'acct_A', participants: ['sam@vendor.io'], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication' } }),
      chunk({ chunkId: 'asana-1', accountId: 'acct_A', metadata: { channel: 'asana', accountId: 'acct_A', participants: ['sam@vendor.io'], ts: '2026-07-10T00:00:00.000Z', sourceType: 'asana' } }),
      chunk({ chunkId: 'other-participant', accountId: 'acct_A', metadata: { channel: 'gmail', accountId: 'acct_A', participants: ['dana@brand-a.com'], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication' } }),
    ]);

    const related = await findRelated(index, 'acct_A', { participant: 'sam@vendor.io' });

    expect(related.map((r) => r.chunkId).sort()).toEqual(['asana-1', 'msg-1']);
  });

  it('links by Asana project (workstream) across every source type', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'c1', accountId: 'acct_A', metadata: { channel: 'gmail', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication', project: 'Q3 Launch' } }),
      chunk({ chunkId: 'a1', accountId: 'acct_A', metadata: { channel: 'asana', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'asana', project: 'Q3 Launch' } }),
      chunk({ chunkId: 'p1', accountId: 'acct_A', metadata: { channel: 'preference', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'preference' } }),
    ]);

    const related = await findRelated(index, 'acct_A', { project: 'Q3 Launch' });

    expect(related.map((r) => r.chunkId).sort()).toEqual(['a1', 'c1']);
  });

  it('filters by sourceId to find every chunk of one record', async () => {
    const index = new InMemoryRetrievalIndex();
    const shared = { chunkId: 'x', accountId: 'acct_A' }; // sourceId derives as `src-x` for both below
    await index.indexChunks([
      chunk({ ...shared, chunkId: 'x-0' }),
      { ...chunk({ ...shared, chunkId: 'x-1' }), sourceId: 'src-x-0' }, // same sourceId, different chunk
      chunk({ chunkId: 'y-0', accountId: 'acct_A' }), // different sourceId (src-y-0)
    ]);

    const related = await findRelated(index, 'acct_A', { sourceId: 'src-x-0' });

    expect(related.map((r) => r.chunkId).sort()).toEqual(['x-0', 'x-1']);
  });

  it('SECURITY: never links across accounts even when the topic matches', async () => {
    const index = new InMemoryRetrievalIndex();
    await index.indexChunks([
      chunk({ chunkId: 'a-chunk', accountId: 'acct_A', metadata: { channel: 'gmail', accountId: 'acct_A', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication', topic: 'shared-topic-name' } }),
      chunk({ chunkId: 'b-chunk', accountId: 'acct_B', metadata: { channel: 'gmail', accountId: 'acct_B', participants: [], ts: '2026-07-10T00:00:00.000Z', sourceType: 'communication', topic: 'shared-topic-name' } }),
    ]);

    const related = await findRelated(index, 'acct_A', { topic: 'shared-topic-name' });

    expect(related.map((r) => r.chunkId)).toEqual(['a-chunk']);
  });

  it('rejects a call with no linking dimension at all', async () => {
    const index = new InMemoryRetrievalIndex();
    await expect(findRelated(index, 'acct_A', {})).rejects.toThrow(
      /at least one linking dimension/,
    );
  });
});

import type { Client } from '@opensearch-project/opensearch';
import { CHUNKS_INDEX_NAME, chunksIndexBody } from '../index-mapping.js';
import type { EmbeddedChunk } from '../corpus.js';
import type { RetrievalIndex, SearchFilters, SearchHit, SearchOptions } from '../retrieval-index.js';

/**
 * The deployed (and Docker-local-replay) `RetrievalIndex` adapter — the OpenSearch-backed
 * implementation of the interface defined in `retrieval-index.ts`. Both the AWS domain
 * (`createSignedOpenSearchClient`) and the Docker Compose local replay connect through this same
 * class against the same `chunksIndexBody()` mapping (brief constraint 2: "runs the SAME index
 * mapping + query code locally").
 */
export class OpenSearchRetrievalIndex implements RetrievalIndex {
  constructor(private readonly client: Client) {}

  /** Creates the `communications-chunks` index if it does not already exist. Idempotent. */
  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: CHUNKS_INDEX_NAME });
    if (exists.body) return;
    await this.client.indices.create({ index: CHUNKS_INDEX_NAME, body: chunksIndexBody() });
  }

  async indexChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const body = chunks.flatMap((chunk) => [
      { index: { _index: CHUNKS_INDEX_NAME, _id: chunk.chunkId } },
      toDocument(chunk),
    ]);

    const response = await this.client.bulk({ body, refresh: true });
    if (response.body.errors) {
      const failed = (response.body.items as Array<Record<string, { error?: unknown }>>)
        .map((item) => Object.values(item)[0])
        .filter((op) => op?.error);
      throw new Error(`OpenSearch bulk index had ${failed.length} failed item(s): ${JSON.stringify(failed[0])}`);
    }
  }

  /**
   * Hybrid kNN + keyword (BM25) query. `metadata.account_id` is a mandatory `filter` clause
   * (design.md §10 — the permission boundary is enforced by an exact-match filter, never by
   * vector similarity) applied identically whether or not the caller passes additional
   * `SearchFilters`.
   */
  async search(queryEmbedding: number[], queryText: string, options: SearchOptions): Promise<SearchHit[]> {
    const { accountId, topK, filters } = options;

    const filterClauses: Record<string, unknown>[] = [{ term: { 'metadata.account_id': accountId } }];
    for (const clause of toFilterClauses(filters)) {
      filterClauses.push(clause);
    }

    const response = await this.client.search({
      index: CHUNKS_INDEX_NAME,
      body: {
        size: topK,
        query: {
          bool: {
            filter: filterClauses,
            should: [
              {
                knn: {
                  embedding: { vector: queryEmbedding, k: topK },
                },
              },
              {
                match: { text_for_embedding: { query: queryText } },
              },
            ],
            minimum_should_match: 0,
          },
        },
      },
    });

    const hits = response.body.hits?.hits ?? [];
    return hits.map((hit: OpenSearchHit) => fromHit(hit));
  }
}

interface OpenSearchHit {
  _score: number;
  _source: {
    chunk_id: string;
    source_id: string;
    text_for_context: string;
    metadata: Record<string, unknown> & { account_id: string };
  };
}

function toDocument(chunk: EmbeddedChunk): Record<string, unknown> {
  return {
    chunk_id: chunk.chunkId,
    source_id: chunk.sourceId,
    chunk_index: chunk.chunkIndex,
    text_for_embedding: chunk.textForEmbedding,
    text_for_context: chunk.textForContext,
    embedding: chunk.embedding,
    metadata: {
      channel: chunk.metadata.channel,
      account_id: chunk.metadata.accountId,
      participants: chunk.metadata.participants,
      topic: chunk.metadata.topic,
      project: chunk.metadata.project,
      asana_gid: chunk.metadata.asanaGid,
      ts: chunk.metadata.ts,
      source_type: chunk.metadata.sourceType,
    },
  };
}

function fromHit(hit: OpenSearchHit): SearchHit {
  const m = hit._source.metadata;
  return {
    chunkId: hit._source.chunk_id,
    sourceId: hit._source.source_id,
    textForContext: hit._source.text_for_context,
    score: hit._score,
    metadata: {
      channel: m.channel as never,
      accountId: m.account_id,
      participants: (m.participants as string[]) ?? [],
      topic: m.topic as string | undefined,
      project: m.project as string | undefined,
      asanaGid: m.asana_gid as string | undefined,
      ts: m.ts as string,
      sourceType: m.source_type as never,
    },
  };
}

function toFilterClauses(filters?: SearchFilters): Record<string, unknown>[] {
  if (!filters) return [];
  const clauses: Record<string, unknown>[] = [];
  if (filters.participant) clauses.push({ term: { 'metadata.participants': filters.participant } });
  if (filters.topic) clauses.push({ term: { 'metadata.topic': filters.topic } });
  if (filters.project) clauses.push({ term: { 'metadata.project': filters.project } });
  if (filters.asanaGid) clauses.push({ term: { 'metadata.asana_gid': filters.asanaGid } });
  if (filters.channel) clauses.push({ term: { 'metadata.channel': filters.channel } });
  if (filters.sourceType) clauses.push({ term: { 'metadata.source_type': filters.sourceType } });
  return clauses;
}

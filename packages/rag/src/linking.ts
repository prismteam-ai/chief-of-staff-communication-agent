import type { RetrievalIndex, SearchHit } from './retrieval-index.js';

/**
 * Cross-channel linking (design.md §4 "not embeddings alone"; README L28). `findRelated` answers
 * "what else, across every channel and source type, shares this dimension" purely through
 * `metadata` filters — no vector similarity involved, so a gmail thread and an unrelated-looking
 * sms both surface when they share a `topic`/`project`/`asanaGid`/participant, and nothing
 * surfaces just because it happens to be semantically similar text.
 *
 * "Workstreams" (README L5) map to Asana projects/topics in this linking metadata (design.md §4),
 * so `findRelated({ project })` / `findRelated({ topic })` IS the workstream view.
 */
export interface FindRelatedQuery {
  /** Every hit whose sourceId equals this exactly (typically a `commId`) — same-record chunks. */
  sourceId?: string;
  /** Every hit that lists this participant identity (email, phone, handle) in its metadata. */
  participant?: string;
  topic?: string;
  project?: string;
  asanaGid?: string;
}

const NEUTRAL_QUERY_TEXT = '';

/**
 * Runs a filter-only lookup against a `RetrievalIndex` (no query embedding — see module doc). At
 * least one of `sourceId`/`participant`/`topic`/`project`/`asanaGid` must be given, or every
 * chunk in the account would match and the "related" framing would be meaningless.
 */
export async function findRelated(
  index: RetrievalIndex,
  accountId: string,
  query: FindRelatedQuery,
  options: { topK?: number; queryEmbeddingDimension: number } = { queryEmbeddingDimension: 0 },
): Promise<SearchHit[]> {
  const { sourceId, participant, topic, project, asanaGid } = query;
  if (!sourceId && !participant && !topic && !project && !asanaGid) {
    throw new Error('findRelated requires at least one linking dimension (sourceId/participant/topic/project/asanaGid)');
  }

  const topK = options.topK ?? 50;
  const zeroVector = new Array<number>(options.queryEmbeddingDimension).fill(0);

  const hits = await index.search(zeroVector, NEUTRAL_QUERY_TEXT, {
    accountId,
    topK,
    filters: { participant, topic, project, asanaGid },
  });

  // sourceId is not a `SearchFilters` field (it identifies one record, not a linking dimension
  // shared across records) — applied as a post-filter over the metadata-filtered result set.
  return sourceId ? hits.filter((h) => h.sourceId === sourceId) : hits;
}

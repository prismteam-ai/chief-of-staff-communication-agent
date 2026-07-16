import type { EmbeddedChunk } from './corpus.js';

/**
 * Optional metadata filters applied ON TOP OF the mandatory account filter (design.md §4
 * cross-channel linking dimensions). All are exact-match `keyword` filters in the index.
 */
export interface SearchFilters {
  participant?: string;
  topic?: string;
  project?: string;
  asanaGid?: string;
  channel?: string;
  sourceType?: string;
}

export interface SearchOptions {
  /**
   * The querying account. This is the permission boundary (design.md §10): `search()` MUST filter
   * on it on every call, and an implementation that does not is a security defect, not a
   * performance one. It is a required field precisely so a caller cannot forget it.
   */
  accountId: string;
  topK: number;
  filters?: SearchFilters;
}

/** One retrieval hit: the chunk's citation surface plus its combined score. */
export interface SearchHit {
  chunkId: string;
  sourceId: string;
  textForContext: string;
  score: number;
  metadata: EmbeddedChunk['metadata'];
}

/**
 * The retrieval seam (design.md §4: "Retrieval sits behind the `RetrievalIndex` interface ... so
 * the index or the embedding model can be swapped without touching consumers"). The processor, the
 * agent tools (Task 5), and the API (Task 6) all depend on this interface, not on OpenSearch.
 *
 * `search()` takes a PRE-COMPUTED query embedding so the embedding model dependency lives in one
 * place (the caller / a `SearchClient` wrapper) rather than being baked into every index adapter,
 * and so the in-memory test double never needs a Bedrock client.
 */
export interface RetrievalIndex {
  indexChunks(chunks: EmbeddedChunk[]): Promise<void>;
  search(queryEmbedding: number[], queryText: string, options: SearchOptions): Promise<SearchHit[]>;
}

/** Cosine similarity of two equal-length vectors; 0 if either is a zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Fraction of query terms present in the text — a cheap BM25 stand-in for the in-memory index. */
function lexicalScore(queryText: string, text: string): number {
  const terms = queryText.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  const hits = terms.filter((t) => haystack.includes(t)).length;
  return hits / terms.length;
}

function matchesFilters(chunk: EmbeddedChunk, filters?: SearchFilters): boolean {
  if (!filters) return true;
  const m = chunk.metadata;
  if (filters.participant && !m.participants.includes(filters.participant)) return false;
  if (filters.topic && m.topic !== filters.topic) return false;
  if (filters.project && m.project !== filters.project) return false;
  if (filters.asanaGid && m.asanaGid !== filters.asanaGid) return false;
  if (filters.channel && m.channel !== filters.channel) return false;
  if (filters.sourceType && m.sourceType !== filters.sourceType) return false;
  return true;
}

/**
 * In-memory `RetrievalIndex` — the fast local/test double. It is production-SHAPED, not a stub: it
 * enforces the account filter, applies the same metadata filters, and combines a vector score and a
 * lexical score the way the OpenSearch hybrid query does, so unit tests exercise the real retrieval
 * decision (including the permission boundary) without a container. The OpenSearch adapter is the
 * separately-verified deployed path; this one is never used in AWS.
 */
export class InMemoryRetrievalIndex implements RetrievalIndex {
  private readonly chunks = new Map<string, EmbeddedChunk>();

  async indexChunks(chunks: EmbeddedChunk[]): Promise<void> {
    for (const c of chunks) {
      this.chunks.set(c.chunkId, c); // upsert by chunk id
    }
  }

  async search(
    queryEmbedding: number[],
    queryText: string,
    options: SearchOptions,
  ): Promise<SearchHit[]> {
    const { accountId, topK, filters } = options;

    const candidates = [...this.chunks.values()].filter(
      // The account filter is applied FIRST and unconditionally — the permission boundary.
      (c) => c.metadata.accountId === accountId && matchesFilters(c, filters),
    );

    const scored = candidates.map((c) => {
      const vectorScore = cosineSimilarity(queryEmbedding, c.embedding);
      const lexScore = lexicalScore(queryText, c.textForEmbedding);
      // Hybrid combine: weight vector higher but let strong lexical overlap lift a match. Mirrors
      // the intent of the OpenSearch bool(knn + match) query; exact numeric scores are not compared
      // across local/AWS (skill rule) — only the resulting ranked ids and bands are.
      const score = 0.7 * vectorScore + 0.3 * lexScore;
      return { chunk: c, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(({ chunk, score }) => ({
      chunkId: chunk.chunkId,
      sourceId: chunk.sourceId,
      textForContext: chunk.textForContext,
      score,
      metadata: chunk.metadata,
    }));
  }

  /** Test/inspection helper — the raw stored chunks (used by cross-channel linking on the double). */
  all(): EmbeddedChunk[] {
    return [...this.chunks.values()];
  }
}

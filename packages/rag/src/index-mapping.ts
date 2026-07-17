import { EMBEDDING_DIMENSION } from './model-config.js';

/**
 * The `communications-chunks` OpenSearch index name and mapping — the ONE definition used by both
 * the deployed AWS adapter and the Docker-OpenSearch local replay (brief constraint 2: local
 * "runs the SAME index mapping + query code"). Importing this in both paths is what makes the
 * local replay a real proof of the production query behavior rather than a parallel model.
 */
export const CHUNKS_INDEX_NAME = 'communications-chunks';

/**
 * kNN vector-field parameters.
 *
 *  - `engine: 'lucene'` — the Lucene kNN engine ships in the OpenSearch distribution without the
 *    k-NN plugin's native (nmslib/faiss) libraries and supports exact + approximate search with
 *    metadata pre-filtering, which is exactly what an account-scoped filtered kNN query needs.
 *  - `space_type: 'cosinesimil'` — Cohere Embed v4 vectors are meant to be compared by cosine
 *    similarity; cosine is scale-invariant, so it is robust to any embedding-norm drift.
 *  - `method: 'hnsw'` — approximate nearest neighbor; fine for demo-scale corpora and the standard
 *    choice for this engine.
 */
export const KNN_SPACE_TYPE = 'cosinesimil';

/**
 * The index body (settings + mappings). `index.knn: true` enables the kNN query type. The
 * `embedding` field is a `knn_vector` of the pinned dimension (a mismatch between this and the
 * embedder output is a hard index error, which is why both read `EMBEDDING_DIMENSION`).
 *
 * `metadata.account_id` is a `keyword` so it can be an exact `term` filter on every query — the
 * permission boundary is enforced by a filter clause, never by vector similarity (skill rule:
 * "Do not rely on vector similarity to enforce tenant or data-governance boundaries").
 */
export function chunksIndexBody(): Record<string, unknown> {
  return {
    settings: {
      index: {
        knn: true,
      },
    },
    mappings: {
      properties: {
        chunk_id: { type: 'keyword' },
        source_id: { type: 'keyword' },
        chunk_index: { type: 'integer' },
        // Searched lexically (BM25) in the hybrid query, and embedded.
        text_for_embedding: { type: 'text' },
        // Returned as the citation surface; not analyzed for search.
        text_for_context: { type: 'text' },
        embedding: {
          type: 'knn_vector',
          dimension: EMBEDDING_DIMENSION,
          method: {
            name: 'hnsw',
            space_type: KNN_SPACE_TYPE,
            engine: 'lucene',
          },
        },
        metadata: {
          properties: {
            channel: { type: 'keyword' },
            account_id: { type: 'keyword' },
            participants: { type: 'keyword' },
            topic: { type: 'keyword' },
            project: { type: 'keyword' },
            asana_gid: { type: 'keyword' },
            ts: { type: 'date' },
            source_type: { type: 'keyword' },
          },
        },
      },
    },
  };
}

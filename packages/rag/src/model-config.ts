/**
 * Pinned model configuration — the ONE place embedding model ids and the vector dimension live
 * (design.md §4: "model ids are pinned in one config module, so the index or the embedding model
 * can be swapped without touching consumers").
 *
 * ## Why the `us.` inference-profile id, not the bare model id
 *
 * The embedding model is Cohere Embed v4 on Amazon Bedrock. In us-east-2 the bare model id
 * `cohere.embed-v4:0` throws `ValidationException` on `InvokeModel` — that model is only reachable
 * through a **cross-region inference profile**, whose id is prefixed `us.`. This was verified live
 * (2026-07-16, `AWS_PROFILE=sandbox AWS_REGION=us-east-2`) with a real
 * `aws bedrock-runtime invoke-model` call:
 *
 *   - model id used:  `us.cohere.embed-v4:0`
 *   - request body:   `{"texts":["..."],"input_type":"search_document","embedding_types":["float"]}`
 *   - response body:  `{"id","texts","embeddings":{"float":[[ ...1536 floats... ]]},"response_type"}`
 *   - embedding dim:  **1536** (`embeddings.float[0].length`)
 *
 * The dimension is pinned here because the OpenSearch `knn_vector` mapping must declare it at index
 * creation time and it must match what the embedder returns — a mismatch is a hard index error, not
 * a soft degradation, so it belongs in one asserted constant, not two hand-copied numbers.
 */

/** Cohere Embed v4 via the us cross-region inference profile (bare id throws ValidationException). */
export const EMBEDDING_MODEL_ID = 'us.cohere.embed-v4:0';

/** Vector dimension returned by {@link EMBEDDING_MODEL_ID} — verified live, see module doc. */
export const EMBEDDING_DIMENSION = 1536;

/**
 * Cohere `input_type` values. Cohere embeds documents and queries into the same space but with
 * different prompts: index-time chunks use `search_document`, query-time text uses `search_query`.
 * Using the wrong one silently degrades recall, so the two call sites pick explicitly.
 */
export const EMBED_INPUT_TYPE = {
  document: 'search_document',
  query: 'search_query',
} as const;
export type EmbedInputType = (typeof EMBED_INPUT_TYPE)[keyof typeof EMBED_INPUT_TYPE];

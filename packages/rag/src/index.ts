/**
 * `@chief-of-staff/rag` — the knowledge-layer / RAG capability (design.md §4). Retrieval sits
 * behind the `RetrievalIndex` interface and embedding model ids are pinned in `model-config.ts`,
 * so the index or the embedding model can be swapped without touching consumers (the ingest
 * processor now, the agent tools and API in later tasks).
 *
 * Kept as its own package (not folded into `@chief-of-staff/shared`) because RAG pulls real
 * dependency weight — the Bedrock runtime SDK and the OpenSearch client — that the zod-only
 * `shared` contract package, imported by every app, should not inherit. This mirrors the
 * `@chief-of-staff/connectors` precedent (own package, own deps, subpath exports).
 *
 * The OpenSearch adapter is exported from the `./opensearch` subpath so consumers that only need
 * the pure contracts (types, chunking, model config, the in-memory index for tests) never pull the
 * OpenSearch client transitively.
 */

export * from './model-config.js';
export * from './corpus.js';
export * from './chunk.js';
export * from './index-mapping.js';
export * from './retrieval-index.js';
export * from './embed.js';
export * from './linking.js';

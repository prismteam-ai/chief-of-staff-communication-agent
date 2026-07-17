import {
  createSignedOpenSearchClient,
  OpenSearchRetrievalIndex,
} from '@chief-of-staff/rag/opensearch';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import type { RuntimeEnv } from './env.js';

/**
 * Builds the runtime `RetrievalIndex` the `retrieveContext` tool queries. Mirrors the ingest
 * processor-handler's pattern: the real OpenSearch adapter when `RAG_DOMAIN_ENDPOINT` is set, else
 * an unwired index whose methods reject inside the async call. `retrieveContext` catches that
 * rejection and returns no hits, so an unwired/unavailable RAG domain degrades the turn (the agent
 * classifies with no retrieved context) rather than hard-failing it.
 */
let cachedRealIndex: OpenSearchRetrievalIndex | undefined;

const UNWIRED_MESSAGE = 'RAG_DOMAIN_ENDPOINT not set — context retrieval unavailable';

const unwiredRetrievalIndex: RetrievalIndex = {
  indexChunks: () => Promise.reject(new Error(UNWIRED_MESSAGE)),
  search: () => Promise.reject(new Error(UNWIRED_MESSAGE)),
  filterSearch: () => Promise.reject(new Error(UNWIRED_MESSAGE)),
};

export function createRetrievalIndex(env: RuntimeEnv): RetrievalIndex {
  if (!env.ragDomainEndpoint) {
    return unwiredRetrievalIndex;
  }
  cachedRealIndex ??= new OpenSearchRetrievalIndex(
    createSignedOpenSearchClient({ endpoint: env.ragDomainEndpoint, region: env.region }),
  );
  return cachedRealIndex;
}

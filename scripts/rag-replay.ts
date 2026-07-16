#!/usr/bin/env tsx
/**
 * `just rag-replay-local` / `just rag-replay-aws` (brief constraints 2 & 8, design.md §4 "local
 * proof ... golden queries replayed against the deployed index").
 *
 * Loads `fixtures/rag/corpus.jsonl`, embeds every chunk's `textForEmbedding` via the pinned
 * Cohere Embed v4 profile (real Bedrock call — this is the SAME embedder both modes use, so a
 * passing local replay is evidence about the query/index code, not a stand-in for the model),
 * indexes into the target OpenSearch (local Docker container or the deployed domain), then embeds
 * and runs every query in `fixtures/rag/golden-queries.json`'s `queries` (vector + keyword hybrid
 * search) and `findRelatedQueries` (filter-only cross-channel linking, no query embedding —
 * `findRelated`/`RetrievalIndex.filterSearch`) and asserts, for both:
 *   - every `expectedTopChunkIds` entry appears within the query's `topK` results
 *   - no `mustNotContainChunkIds` entry appears at all (the account-isolation assertions)
 *
 * `--mode local` targets `docker-compose.rag.yml` (localhost:9200, unsigned). `--mode aws` reads
 * the deployed domain endpoint from `RagStack`'s `DomainEndpoint` CloudFormation output and
 * SigV4-signs every request with the operator's `AWS_PROFILE` credentials — proving the SAME
 * `chunksIndexBody()` mapping and `OpenSearchRetrievalIndex` query code work against production
 * OpenSearch with production embeddings, not just the local double.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  createLocalOpenSearchClient,
  createSignedOpenSearchClient,
  OpenSearchRetrievalIndex,
} from '@chief-of-staff/rag/opensearch';
import { embedText, embedTexts, EMBED_INPUT_TYPE, findRelated } from '@chief-of-staff/rag';
import type { EmbeddedChunk, FindRelatedQuery } from '@chief-of-staff/rag';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION ?? 'us-east-2';
const CORPUS_PATH = path.join(__dirname, '../fixtures/rag/corpus.jsonl');
const GOLDEN_QUERIES_PATH = path.join(__dirname, '../fixtures/rag/golden-queries.json');

function fail(message: string): never {
  console.error(`[rag-replay] FAIL: ${message}`);
  process.exit(1);
}

function parseMode(): 'local' | 'aws' {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  const mode = arg?.split('=')[1] ?? process.env.RAG_REPLAY_MODE;
  if (mode !== 'local' && mode !== 'aws') {
    fail('Pass --mode=local or --mode=aws');
  }
  return mode;
}

interface CorpusRow {
  chunkId: string;
  sourceId: string;
  chunkIndex: number;
  textForEmbedding: string;
  textForContext: string;
  metadata: EmbeddedChunk['metadata'];
}

function loadCorpus(): CorpusRow[] {
  const raw = readFileSync(CORPUS_PATH, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusRow);
}

interface GoldenQuery {
  id: string;
  queryText: string;
  accountId: string;
  topK: number;
  filters?: Record<string, string>;
  expectedTopChunkIds: string[];
  mustNotContainChunkIds: string[];
  note?: string;
}

function loadGoldenQueries(): GoldenQuery[] {
  const raw = readFileSync(GOLDEN_QUERIES_PATH, 'utf-8');
  return (JSON.parse(raw) as { queries: GoldenQuery[] }).queries;
}

/**
 * `findRelated` golden cases (linking.ts's filter-only path, `RetrievalIndex.filterSearch`) —
 * replayed against the SAME `OpenSearchRetrievalIndex` the vector golden queries use, proving the
 * no-knn filter-only query works against a real HNSW/Lucene kNN index, not just the in-memory
 * double (which never throws on a zero vector and so never proved anything about this path).
 */
interface FindRelatedGoldenQuery {
  id: string;
  accountId: string;
  query: FindRelatedQuery;
  topK: number;
  expectedTopChunkIds: string[];
  mustNotContainChunkIds: string[];
  note?: string;
}

function loadFindRelatedQueries(): FindRelatedGoldenQuery[] {
  const raw = readFileSync(GOLDEN_QUERIES_PATH, 'utf-8');
  return (JSON.parse(raw) as { findRelatedQueries?: FindRelatedGoldenQuery[] }).findRelatedQueries ?? [];
}

async function getDeployedDomainEndpoint(): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: 'RagStack' }));
  const endpoint = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'DomainEndpoint')?.OutputValue;
  if (!endpoint) fail('RagStack DomainEndpoint output not found — is RagStack deployed?');
  return endpoint;
}

async function main() {
  const mode = parseMode();
  console.log(`[rag-replay] mode=${mode}`);

  const index =
    mode === 'local'
      ? new OpenSearchRetrievalIndex(createLocalOpenSearchClient({ node: 'http://localhost:9200' }))
      : new OpenSearchRetrievalIndex(
          createSignedOpenSearchClient({ endpoint: await getDeployedDomainEndpoint(), region: REGION }),
        );

  console.log('[rag-replay] ensuring index exists (idempotent)...');
  await index.ensureIndex();

  const corpus = loadCorpus();
  console.log(`[rag-replay] embedding ${corpus.length} corpus chunks via ${mode === 'local' ? 'real Bedrock (fixtures are embedded live even in local mode)' : 'real Bedrock'}...`);

  const vectors = await embedTexts(
    corpus.map((c) => c.textForEmbedding),
    EMBED_INPUT_TYPE.document,
  );

  const embedded: EmbeddedChunk[] = corpus.map((c, i) => ({
    chunkId: c.chunkId,
    sourceId: c.sourceId,
    chunkIndex: c.chunkIndex,
    textForEmbedding: c.textForEmbedding,
    textForContext: c.textForContext,
    metadata: c.metadata,
    embedding: vectors[i]!,
  }));

  console.log('[rag-replay] indexing corpus (deterministic ids -> idempotent upsert)...');
  await index.indexChunks(embedded);

  const queries = loadGoldenQueries();
  console.log(`[rag-replay] replaying ${queries.length} golden queries...`);

  let failures = 0;
  for (const q of queries) {
    const queryEmbedding = await embedText(q.queryText, EMBED_INPUT_TYPE.query);
    const hits = await index.search(queryEmbedding, q.queryText, {
      accountId: q.accountId,
      topK: q.topK,
      filters: q.filters,
    });
    const hitIds = hits.map((h) => h.chunkId);

    const missingExpected = q.expectedTopChunkIds.filter((id) => !hitIds.includes(id));
    const leakedForbidden = q.mustNotContainChunkIds.filter((id) => hitIds.includes(id));

    if (missingExpected.length === 0 && leakedForbidden.length === 0) {
      console.log(`[rag-replay] PASS  ${q.id}  (${hitIds.length} hits: ${hitIds.join(', ')})`);
    } else {
      failures++;
      console.error(`[rag-replay] FAIL  ${q.id}`);
      if (missingExpected.length > 0) console.error(`  missing expected: ${missingExpected.join(', ')}`);
      if (leakedForbidden.length > 0) console.error(`  leaked forbidden: ${leakedForbidden.join(', ')}`);
      console.error(`  got: ${hitIds.join(', ')}`);
    }
  }

  const findRelatedQueries = loadFindRelatedQueries();
  console.log(`[rag-replay] replaying ${findRelatedQueries.length} findRelated (filter-only) golden queries...`);

  for (const q of findRelatedQueries) {
    const hits = await findRelated(index, q.accountId, q.query, { topK: q.topK });
    const hitIds = hits.map((h) => h.chunkId);

    const missingExpected = q.expectedTopChunkIds.filter((id) => !hitIds.includes(id));
    const leakedForbidden = q.mustNotContainChunkIds.filter((id) => hitIds.includes(id));

    if (missingExpected.length === 0 && leakedForbidden.length === 0) {
      console.log(`[rag-replay] PASS  ${q.id}  (${hitIds.length} hits: ${hitIds.join(', ')})`);
    } else {
      failures++;
      console.error(`[rag-replay] FAIL  ${q.id}`);
      if (missingExpected.length > 0) console.error(`  missing expected: ${missingExpected.join(', ')}`);
      if (leakedForbidden.length > 0) console.error(`  leaked forbidden: ${leakedForbidden.join(', ')}`);
      console.error(`  got: ${hitIds.join(', ')}`);
    }
  }

  const totalQueries = queries.length + findRelatedQueries.length;
  if (failures > 0) {
    fail(`${failures}/${totalQueries} golden queries failed.`);
  }

  console.log(`\n[rag-replay] PASS — all ${totalQueries} golden queries returned expected results (mode=${mode}).\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

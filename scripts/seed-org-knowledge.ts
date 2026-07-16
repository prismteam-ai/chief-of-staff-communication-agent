#!/usr/bin/env tsx
/**
 * `just seed-org-knowledge` (brief constraint 6): idempotent, deterministic-id indexing of the
 * seeded org-doc + user-preference fixtures into the DEPLOYED OpenSearch domain — the org
 * knowledge design.md §4 describes as "seeded at setup and editable in the dashboard" /
 * "organizational knowledge (... seeded org documents)".
 *
 * Reuses `fixtures/rag/corpus.jsonl` (the same corpus `just rag-replay-aws` replays golden
 * queries against) filtered to `sourceType: org_doc | preference` — one fixture file, no drift
 * between what the replay proves retrieval against and what an operator actually seeds. Chunk ids
 * are content-hash-derived (`chunkIdFor`, `@chief-of-staff/rag`), so re-running this script
 * upserts identical documents rather than duplicating — safe to run repeatedly, e.g. after
 * editing an org-doc fixture's text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createSignedOpenSearchClient, OpenSearchRetrievalIndex } from '@chief-of-staff/rag/opensearch';
import { embedTexts, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import type { EmbeddedChunk } from '@chief-of-staff/rag';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION ?? 'us-east-2';
const CORPUS_PATH = path.join(__dirname, '../fixtures/rag/corpus.jsonl');
const SEEDED_SOURCE_TYPES = new Set(['org_doc', 'preference']);

function fail(message: string): never {
  console.error(`[seed-org-knowledge] FAIL: ${message}`);
  process.exit(1);
}

interface CorpusRow {
  chunkId: string;
  sourceId: string;
  chunkIndex: number;
  textForEmbedding: string;
  textForContext: string;
  metadata: EmbeddedChunk['metadata'];
}

function loadSeedableRows(): CorpusRow[] {
  const raw = readFileSync(CORPUS_PATH, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusRow)
    .filter((row) => SEEDED_SOURCE_TYPES.has(row.metadata.sourceType));
}

async function getDeployedDomainEndpoint(): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: 'RagStack' }));
  const endpoint = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'DomainEndpoint')?.OutputValue;
  if (!endpoint) fail('RagStack DomainEndpoint output not found — is RagStack deployed?');
  return endpoint;
}

async function main() {
  const rows = loadSeedableRows();
  if (rows.length === 0) fail('No org_doc/preference rows found in fixtures/rag/corpus.jsonl');

  console.log(`[seed-org-knowledge] seeding ${rows.length} org-doc/preference chunk(s)...`);

  const endpoint = await getDeployedDomainEndpoint();
  const index = new OpenSearchRetrievalIndex(createSignedOpenSearchClient({ endpoint, region: REGION }));
  await index.ensureIndex();

  const vectors = await embedTexts(
    rows.map((r) => r.textForEmbedding),
    EMBED_INPUT_TYPE.document,
  );

  const embedded: EmbeddedChunk[] = rows.map((r, i) => ({
    chunkId: r.chunkId,
    sourceId: r.sourceId,
    chunkIndex: r.chunkIndex,
    textForEmbedding: r.textForEmbedding,
    textForContext: r.textForContext,
    metadata: r.metadata,
    embedding: vectors[i]!,
  }));

  await index.indexChunks(embedded);

  for (const row of rows) {
    console.log(`[seed-org-knowledge] seeded  ${row.chunkId}  (${row.metadata.sourceType}, account=${row.metadata.accountId})`);
  }

  console.log(`\n[seed-org-knowledge] PASS — ${embedded.length} chunk(s) upserted into communications-chunks.\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

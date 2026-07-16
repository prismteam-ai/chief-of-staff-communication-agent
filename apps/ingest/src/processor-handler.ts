import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import middy from '@middy/core';
import { createSignedOpenSearchClient, OpenSearchRetrievalIndex } from '@chief-of-staff/rag/opensearch';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import { createDedupeRepo } from './dedupe-repo.js';
import { createCommunicationsRepo } from './communications-repo.js';
import { createRawArtifactStore } from './raw-artifact-store.js';
import { createGmailClientForAccount } from './gmail-client.js';
import {
  makeFetchGmailAttachment,
  makeFetchGmailMessage,
  processOneMessage,
  type ProcessOneMessageInput,
} from './processor-logic.js';
import { logger, metrics, tracer } from './context.js';

const DEDUPE_TABLE_NAME = process.env.DEDUPE_TABLE_NAME ?? '';
const COMMUNICATIONS_TABLE_NAME = process.env.COMMUNICATIONS_TABLE_NAME ?? '';
const RAW_ARTIFACT_BUCKET_NAME = process.env.RAW_ARTIFACT_BUCKET_NAME ?? '';
// Set once RagStack's domain exists (brief constraint 8 — wired after the OpenSearch domain
// CREATE completes). Absent, `requireEnv` still passes: an unset endpoint degrades to
// `indexChunksIsolated` warning + `ChunkIndexFailed` per message rather than blocking ingestion,
// consistent with the "embed/index failure must not fail ingestion" rule.
const RAG_DOMAIN_ENDPOINT = process.env.RAG_DOMAIN_ENDPOINT ?? '';
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-2';

function requireEnv(): void {
  if (!DEDUPE_TABLE_NAME || !COMMUNICATIONS_TABLE_NAME || !RAW_ARTIFACT_BUCKET_NAME) {
    throw new Error(
      'DEDUPE_TABLE_NAME, COMMUNICATIONS_TABLE_NAME, and RAW_ARTIFACT_BUCKET_NAME must be set',
    );
  }
}

/**
 * SQS-triggered: processes one enqueued `{accountId, messageId}` per record. Uses SQS's
 * `functionResponseType: ReportBatchItemFailures` shape — a failed record is reported back so
 * only that record redelivers (eventually to the DLQ after maxReceiveCount), rather than the
 * whole batch retrying and re-processing already-succeeded messages.
 */
/** Built once per Lambda execution environment (module-level cache — same pattern as
 * `communications-repo.ts`'s `client()`). */
let cachedRealRetrievalIndex: OpenSearchRetrievalIndex | undefined;
function realRetrievalIndex(): OpenSearchRetrievalIndex {
  cachedRealRetrievalIndex ??= new OpenSearchRetrievalIndex(
    createSignedOpenSearchClient({ endpoint: RAG_DOMAIN_ENDPOINT, region: AWS_REGION }),
  );
  return cachedRealRetrievalIndex;
}

/**
 * When `RAG_DOMAIN_ENDPOINT` is unset (RagStack not yet wired for this deploy), every method
 * rejects INSIDE the async call rather than the handler throwing synchronously while building
 * dependencies — `indexChunksIsolated` in `processor-logic.ts` wraps exactly that async call in
 * its own try/catch and turns the rejection into a warn + `ChunkIndexFailed` metric, so ingestion
 * itself is never blocked by the RAG domain being unavailable or unwired.
 */
const unwiredRetrievalIndex: RetrievalIndex = {
  indexChunks: () => Promise.reject(new Error('RAG_DOMAIN_ENDPOINT not set — chunk indexing unavailable')),
  search: () => Promise.reject(new Error('RAG_DOMAIN_ENDPOINT not set — chunk indexing unavailable')),
  filterSearch: () => Promise.reject(new Error('RAG_DOMAIN_ENDPOINT not set — chunk indexing unavailable')),
};

function retrievalIndex(): RetrievalIndex {
  return RAG_DOMAIN_ENDPOINT ? realRetrievalIndex() : unwiredRetrievalIndex;
}

async function baseHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  requireEnv();

  const dedupeRepo = createDedupeRepo(DEDUPE_TABLE_NAME);
  const communicationsRepo = createCommunicationsRepo(COMMUNICATIONS_TABLE_NAME);
  const rawArtifactStore = createRawArtifactStore(RAW_ARTIFACT_BUCKET_NAME);
  const fetchMessage = makeFetchGmailMessage(createGmailClientForAccount);
  const fetchAttachment = makeFetchGmailAttachment(createGmailClientForAccount);

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let input: ProcessOneMessageInput;
    try {
      input = JSON.parse(record.body) as ProcessOneMessageInput;
    } catch {
      logger.error('Unparseable SQS record body — routing to DLQ', { messageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const result = await processOneMessage(input, {
      fetchMessage,
      fetchAttachment,
      dedupeRepo,
      communicationsRepo,
      rawArtifactStore,
      retrievalIndex: retrievalIndex(),
      log: logger,
      metricsClient: metrics,
    });

    if (result.outcome === 'failed') {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger, { logEvent: false }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));

import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import middy from '@middy/core';
import { createDedupeRepo } from './dedupe-repo.js';
import { createCommunicationsRepo } from './communications-repo.js';
import { createRawArtifactStore } from './raw-artifact-store.js';
import { createGmailClientForAccount } from './gmail-client.js';
import { makeFetchGmailMessage, processOneMessage, type ProcessOneMessageInput } from './processor-logic.js';
import { logger, metrics, tracer } from './context.js';

const DEDUPE_TABLE_NAME = process.env.DEDUPE_TABLE_NAME ?? '';
const COMMUNICATIONS_TABLE_NAME = process.env.COMMUNICATIONS_TABLE_NAME ?? '';
const RAW_ARTIFACT_BUCKET_NAME = process.env.RAW_ARTIFACT_BUCKET_NAME ?? '';

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
async function baseHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  requireEnv();

  const dedupeRepo = createDedupeRepo(DEDUPE_TABLE_NAME);
  const communicationsRepo = createCommunicationsRepo(COMMUNICATIONS_TABLE_NAME);
  const rawArtifactStore = createRawArtifactStore(RAW_ARTIFACT_BUCKET_NAME);
  const fetchMessage = makeFetchGmailMessage(createGmailClientForAccount);

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
      dedupeRepo,
      communicationsRepo,
      rawArtifactStore,
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

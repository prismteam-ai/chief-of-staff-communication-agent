import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import middy from '@middy/core';
import { createAccountsRepo } from './accounts-repo.js';
import { createGmailClientForAccount } from './gmail-client.js';
import { pollAllAccounts, type EnqueueMessage } from './poller-logic.js';
import { logger, metrics, tracer } from './context.js';

const ACCOUNTS_TABLE_NAME = process.env.ACCOUNTS_TABLE_NAME ?? '';
const INGEST_QUEUE_URL = process.env.INGEST_QUEUE_URL ?? '';

// SQS SendMessageBatch caps at 10 entries per call.
const SQS_BATCH_SIZE = 10;

const sqs = new SQSClient({});

async function enqueueToSqs(messages: EnqueueMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += SQS_BATCH_SIZE) {
    const batch = messages.slice(i, i + SQS_BATCH_SIZE);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: INGEST_QUEUE_URL,
        Entries: batch.map((m, index) => ({
          Id: `${i + index}`,
          MessageBody: JSON.stringify(m),
        })),
      }),
    );
  }
}

async function baseHandler(): Promise<void> {
  if (!ACCOUNTS_TABLE_NAME || !INGEST_QUEUE_URL) {
    throw new Error('ACCOUNTS_TABLE_NAME and INGEST_QUEUE_URL must be set');
  }

  const accountsRepo = createAccountsRepo(ACCOUNTS_TABLE_NAME);
  const start = Date.now();

  const results = await pollAllAccounts(
    accountsRepo,
    createGmailClientForAccount,
    enqueueToSqs,
    logger,
    metrics,
  );

  metrics.addMetric('ProcessingDuration', MetricUnit.Milliseconds, Date.now() - start);
  logger.info('Poller tick complete', {
    accountsPolled: results.length,
    totalEnqueued: results.reduce((sum, r) => sum + r.enqueuedCount, 0),
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger, { logEvent: false }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));

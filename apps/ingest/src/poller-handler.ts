import { SQSClient, SendMessageBatchCommand, type SendMessageBatchCommandOutput } from '@aws-sdk/client-sqs';
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

export type SendMessageBatchFn = (
  entries: { Id: string; MessageBody: string }[],
) => Promise<SendMessageBatchCommandOutput>;

async function sendBatchViaSqs(
  entries: { Id: string; MessageBody: string }[],
): Promise<SendMessageBatchCommandOutput> {
  return sqs.send(new SendMessageBatchCommand({ QueueUrl: INGEST_QUEUE_URL, Entries: entries }));
}

/**
 * Sends one batch (<=10 entries) and retries any partially-failed entries once (brief: a
 * `SendMessageBatch` response can report some entries `Failed` while others succeed — a single
 * throttled/transient entry should not be silently dropped nor should it fail the whole batch
 * without a retry). If any entry is still `Failed` after the retry, throws so the caller (one
 * account's `pollAccount` call) does not advance its history cursor this tick — the next tick's
 * `history.list` will find the same messages again, and dedupe protects any that already made it
 * onto the queue.
 */
export async function sendBatchWithRetry(
  entries: { Id: string; MessageBody: string }[],
  send: SendMessageBatchFn,
  log: Pick<typeof logger, 'warn' | 'error'>,
): Promise<void> {
  const first = await send(entries);
  const firstFailed = first.Failed ?? [];
  if (firstFailed.length === 0) return;

  log.warn('SendMessageBatch reported partial failures, retrying failed entries once', {
    failedCount: firstFailed.length,
    totalCount: entries.length,
  });

  const retryEntries = entries.filter((e) => firstFailed.some((f) => f.Id === e.Id));
  const retry = await send(retryEntries);
  const stillFailed = retry.Failed ?? [];

  if (stillFailed.length > 0) {
    log.error('SendMessageBatch entries failed after retry — cursor will not advance this tick', {
      stillFailedCount: stillFailed.length,
      totalCount: entries.length,
      codes: stillFailed.map((f) => f.Code),
    });
    throw new Error(
      `SendMessageBatch: ${stillFailed.length}/${entries.length} entries still failed after one retry`,
    );
  }
}

async function enqueueToSqs(messages: EnqueueMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += SQS_BATCH_SIZE) {
    const batch = messages.slice(i, i + SQS_BATCH_SIZE);
    const entries = batch.map((m, index) => ({ Id: `${i + index}`, MessageBody: JSON.stringify(m) }));
    await sendBatchWithRetry(entries, sendBatchViaSqs, logger);
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

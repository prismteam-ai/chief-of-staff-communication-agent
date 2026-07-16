import type { gmail_v1 } from 'googleapis';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { GmailConnector } from '@chief-of-staff/connectors/gmail';
import type { GmailMessage } from '@chief-of-staff/connectors/gmail';
import type { DedupeRepo } from './dedupe-repo.js';
import { dedupeKeyFor } from './dedupe-repo.js';
import type { CommunicationsRepo } from './communications-repo.js';
import type { RawArtifactStore } from './raw-artifact-store.js';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/**
 * Pure-ish processor logic (design.md §5, brief constraint 3): "processor Lambda: `messages.get`,
 * normalize via the connector, dedupe on provider message id via conditional write to the dedupe
 * table, persist raw JSON to S3 bucket, write communication record in state `ingested`, emit
 * Powertools metrics `MessageIngested`/`MessageFailed` with channel dimension +
 * `ProcessingDuration`."
 *
 * Order of operations matters for idempotency correctness: the dedupe claim happens **before**
 * any persistence side effect. If the claim fails (a duplicate), nothing else runs — this is what
 * "replay of the same event does not duplicate" (brief `Verify`) actually rests on.
 */

const connector = new GmailConnector();

export type FetchGmailMessage = (
  accountId: string,
  messageId: string,
) => Promise<GmailMessage>;

export interface ProcessOneMessageInput {
  accountId: string;
  messageId: string;
}

export type ProcessOutcome =
  | { outcome: 'ingested'; commId: string }
  | { outcome: 'duplicate'; dedupeKey: string }
  | { outcome: 'failed'; error: string };

export async function processOneMessage(
  input: ProcessOneMessageInput,
  deps: {
    fetchMessage: FetchGmailMessage;
    dedupeRepo: DedupeRepo;
    communicationsRepo: CommunicationsRepo;
    rawArtifactStore: RawArtifactStore;
    log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
    metricsClient: Pick<typeof MetricsType, 'addMetric' | 'addDimension'>;
  },
): Promise<ProcessOutcome> {
  const { accountId, messageId } = input;
  const { fetchMessage, dedupeRepo, communicationsRepo, rawArtifactStore, log, metricsClient } = deps;
  const start = Date.now();

  try {
    const raw = await fetchMessage(accountId, messageId);
    const [normalized] = await connector.ingest({ accountId, raw: { messages: [raw] } });
    if (!normalized) {
      throw new Error('Gmail connector produced no normalized message');
    }

    const dedupeKey = dedupeKeyFor(normalized.channelType, normalized.externalId);
    const claimed = await dedupeRepo.claim(dedupeKey);

    if (!claimed) {
      log.info('Duplicate message — dedupe claim lost, skipping persistence', {
        channelType: normalized.channelType,
        messageId,
      });
      return { outcome: 'duplicate', dedupeKey };
    }

    await rawArtifactStore.putRawMessage(normalized.channelType, normalized.externalId, raw);
    const record = await communicationsRepo.putIngested(normalized);

    metricsClient.addDimension('channel', normalized.channelType);
    metricsClient.addMetric('MessageIngested', MetricUnit.Count, 1);
    metricsClient.addMetric('ProcessingDuration', MetricUnit.Milliseconds, Date.now() - start);

    log.info('Ingested message', {
      channelType: normalized.channelType,
      commId: record.commId,
      attachmentCount: normalized.attachments.length,
    });

    return { outcome: 'ingested', commId: record.commId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to process message', { accountId, messageId, error: message });
    metricsClient.addDimension('channel', 'gmail');
    metricsClient.addMetric('MessageFailed', MetricUnit.Count, 1);
    return { outcome: 'failed', error: message };
  }
}

/** Adapts a real `gmail_v1.Gmail` client into the `FetchGmailMessage` shape processor logic needs. */
export function makeFetchGmailMessage(
  gmailClientFactory: (accountId: string) => Promise<gmail_v1.Gmail>,
): FetchGmailMessage {
  return async (accountId, messageId) => {
    const gmail = await gmailClientFactory(accountId);
    const response = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    return response.data as GmailMessage;
  };
}

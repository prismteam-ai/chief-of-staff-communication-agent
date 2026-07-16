import type { gmail_v1 } from 'googleapis';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { GmailConnector } from '@chief-of-staff/connectors/gmail';
import type { GmailMessage } from '@chief-of-staff/connectors/gmail';
import type { Attachment } from '@chief-of-staff/shared';
import type { DedupeRepo } from './dedupe-repo.js';
import { dedupeKeyFor } from './dedupe-repo.js';
import type { CommunicationsRepo } from './communications-repo.js';
import type { RawArtifactStore } from './raw-artifact-store.js';
import { attachmentKey } from './raw-artifact-store.js';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/** Attachment bytes above this size are skipped (logged, not persisted) rather than pulled into
 * Lambda memory / written to S3 — a deliberate guard, not a Gmail API limit. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function decodeBase64UrlToBuffer(data: string): Buffer {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

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

/** Fetches one attachment's raw base64url-encoded bytes via `users.messages.attachments.get`. */
export type FetchGmailAttachment = (
  accountId: string,
  messageId: string,
  attachmentId: string,
) => Promise<string>;

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
    fetchAttachment: FetchGmailAttachment;
    dedupeRepo: DedupeRepo;
    communicationsRepo: CommunicationsRepo;
    rawArtifactStore: RawArtifactStore;
    log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
    metricsClient: Pick<typeof MetricsType, 'addMetric' | 'addDimension'>;
  },
): Promise<ProcessOutcome> {
  const { accountId, messageId } = input;
  const { fetchMessage, fetchAttachment, dedupeRepo, communicationsRepo, rawArtifactStore, log, metricsClient } =
    deps;
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

    const attachments = await persistAttachments(normalized.attachments, {
      accountId,
      messageId,
      fetchAttachment,
      rawArtifactStore,
      log,
    });

    const record = await communicationsRepo.putIngested({ ...normalized, attachments });

    metricsClient.addDimension('channel', normalized.channelType);
    metricsClient.addMetric('MessageIngested', MetricUnit.Count, 1);
    metricsClient.addMetric('ProcessingDuration', MetricUnit.Milliseconds, Date.now() - start);

    log.info('Ingested message', {
      channelType: normalized.channelType,
      commId: record.commId,
      attachmentCount: attachments.length,
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

/**
 * Fetches and persists each attachment's bytes to S3, returning the attachment list with `s3Key`
 * populated on the ones that succeeded. Per-attachment fetch/decode/persist failures are logged
 * and skipped rather than failing the whole message — a torn attachment is not a reason to lose
 * an otherwise-good message (it can be re-fetched from Gmail later; the message cannot be
 * re-delivered once acknowledged). Oversized attachments (>10MB) are skipped the same way, with a
 * warn log — no new metric, since `MessageIngested` already reflects the message succeeding.
 */
async function persistAttachments(
  attachments: Attachment[],
  deps: {
    accountId: string;
    messageId: string;
    fetchAttachment: FetchGmailAttachment;
    rawArtifactStore: RawArtifactStore;
    log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  },
): Promise<Attachment[]> {
  const { accountId, messageId, fetchAttachment, rawArtifactStore, log } = deps;

  const results: Attachment[] = [];
  for (const attachment of attachments) {
    try {
      if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
        log.warn('Skipping attachment over size guard — not fetched or persisted', {
          messageId,
          attachmentId: attachment.id,
          sizeBytes: attachment.sizeBytes,
          maxBytes: MAX_ATTACHMENT_BYTES,
        });
        results.push(attachment);
        continue;
      }

      const base64url = await fetchAttachment(accountId, messageId, attachment.id);
      const bytes = decodeBase64UrlToBuffer(base64url);
      const key = attachmentKey(accountId, messageId, attachment.id);
      await rawArtifactStore.putAttachment(key, bytes, attachment.contentType);

      results.push({ ...attachment, s3Key: key });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Failed to fetch/persist one attachment — message ingest continues', {
        messageId,
        attachmentId: attachment.id,
        error: message,
      });
      results.push(attachment);
    }
  }

  return results;
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

/** Adapts a real `gmail_v1.Gmail` client into the `FetchGmailAttachment` shape processor logic
 * needs — `users.messages.attachments.get` returns `{ data (base64url), size }`. */
export function makeFetchGmailAttachment(
  gmailClientFactory: (accountId: string) => Promise<gmail_v1.Gmail>,
): FetchGmailAttachment {
  return async (accountId, messageId, attachmentId) => {
    const gmail = await gmailClientFactory(accountId);
    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    const data = response.data.data;
    if (!data) {
      throw new Error(`attachments.get returned no data for attachment ${attachmentId}`);
    }
    return data;
  };
}

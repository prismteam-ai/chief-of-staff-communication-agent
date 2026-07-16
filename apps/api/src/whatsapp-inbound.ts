import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { verifyTwilioSignature, WhatsAppConnector } from '@chief-of-staff/connectors/whatsapp';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import { indexMessageChunks } from './rag-index-step.js';
import { dedupeKeyFor, type DedupeRepo } from './repos/dedupe-repo.js';
import type { CommunicationsRepo } from './repos/communications-repo.js';
import type { AgentTrigger } from './agent-trigger.js';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/**
 * The single demo WhatsApp sandbox account (Task 9 brief constraint 2): one Twilio sandbox number,
 * one connected account for the whole demo, owned by the same demo user Gmail is seeded under
 * (`demo-alex`, `scripts/gmail-auth.ts`) so both channels appear together in one unified inbox
 * (README L43 "multiple channels", cross-channel demo).
 */
export const WHATSAPP_DEMO_ACCOUNT_ID = 'acct-whatsapp-sandbox';
export const WHATSAPP_DEMO_USER_ID = 'demo-alex';

const connector = new WhatsAppConnector();

/**
 * Pure signature-verification step, isolated from I/O so it is unit-testable without constructing
 * the whole webhook pipeline (brief constraint 3: "Verify the Twilio signature ... reject
 * unsigned/forged"). `formParams` must be the exact application/x-www-form-urlencoded fields Twilio
 * POSTed (decoded, not re-encoded) and `url` must be the exact public URL Twilio was configured to
 * call — see `twilio-client.ts#verifyTwilioSignature`'s doc comment.
 */
export function isValidTwilioRequest(params: {
  authToken: string;
  url: string;
  formParams: Record<string, string>;
  signatureHeader: string | undefined;
}): boolean {
  return verifyTwilioSignature(params);
}

export type InboundOutcome =
  | { outcome: 'ingested'; commId: string }
  | { outcome: 'duplicate'; dedupeKey: string }
  | { outcome: 'unauthorized' }
  | { outcome: 'failed'; error: string };

export interface ProcessInboundDeps {
  authToken: string;
  /** The exact public webhook URL Twilio was configured to POST to (scheme+host+path). */
  webhookUrl: string;
  dedupeRepo: DedupeRepo;
  communicationsRepo: CommunicationsRepo;
  retrievalIndex: RetrievalIndex;
  agentTrigger: AgentTrigger;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric' | 'addDimension'>;
}

/**
 * Processes one Twilio inbound WhatsApp webhook delivery end to end (Task 9 brief constraint 3):
 * verify signature -> normalize via the WhatsApp connector -> dedupe (conditional write on
 * MessageSid) -> persist (status `ingested`) -> embed/index (isolated) -> trigger the agent
 * (isolated). Mirrors `apps/ingest/src/processor-logic.ts#processOneMessage`'s ordering exactly:
 * the dedupe claim happens before any persistence side effect, and downstream steps (indexing,
 * agent trigger) are isolated so their failure never undoes or fails the ingest outcome.
 *
 * No PII in logs anywhere in this function or its isolated helpers below (brief constraint 3: "NO
 * body/phone-number in logs") — only channel, message id, dedupe key, and error messages are ever
 * logged.
 */
export async function processInboundWhatsAppWebhook(
  formParams: Record<string, string>,
  signatureHeader: string | undefined,
  deps: ProcessInboundDeps,
): Promise<InboundOutcome> {
  const { authToken, webhookUrl, dedupeRepo, communicationsRepo, retrievalIndex, agentTrigger, log, metricsClient } =
    deps;
  const start = Date.now();

  const signatureValid = verifyTwilioSignature({
    authToken,
    url: webhookUrl,
    formParams,
    signatureHeader,
  });

  if (!signatureValid) {
    log.warn('Rejected WhatsApp inbound webhook — invalid or missing Twilio signature', {});
    metricsClient.addDimension('channel', 'whatsapp');
    metricsClient.addMetric('WhatsAppSignatureRejected', MetricUnit.Count, 1);
    return { outcome: 'unauthorized' };
  }

  try {
    const [normalized] = await connector.ingest({
      accountId: WHATSAPP_DEMO_ACCOUNT_ID,
      raw: formParams,
    });
    if (!normalized) {
      throw new Error('WhatsApp connector produced no normalized message');
    }

    const dedupeKey = dedupeKeyFor(normalized.channelType, normalized.externalId);
    const claimed = await dedupeRepo.claim(dedupeKey);

    if (!claimed) {
      log.info('Duplicate WhatsApp message — dedupe claim lost, skipping persistence', {
        channelType: normalized.channelType,
      });
      return { outcome: 'duplicate', dedupeKey };
    }

    const record = await communicationsRepo.putIngested(normalized);

    metricsClient.addDimension('channel', 'whatsapp');
    metricsClient.addMetric('WhatsAppIngested', MetricUnit.Count, 1);
    metricsClient.addMetric('ProcessingDuration', MetricUnit.Milliseconds, Date.now() - start);

    log.info('Ingested WhatsApp message', { commId: record.commId });

    // Isolated exactly like processor-logic.ts's indexChunksIsolated: the communication is already
    // durably persisted above, so a Bedrock/OpenSearch failure here must degrade to a warn +
    // ChunkIndexFailed metric, never flip this outcome to 'failed'.
    await indexChunksIsolated(normalized, { retrievalIndex, log, metricsClient });

    // Isolated exactly like processor-logic.ts's triggerAgentIsolated.
    await triggerAgentIsolated(
      { commId: record.commId, accountId: normalized.accountId },
      { agentTrigger, log, metricsClient },
    );

    return { outcome: 'ingested', commId: record.commId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to process WhatsApp inbound webhook', { error: message });
    metricsClient.addDimension('channel', 'whatsapp');
    metricsClient.addMetric('WhatsAppIngestFailed', MetricUnit.Count, 1);
    return { outcome: 'failed', error: message };
  }
}

async function indexChunksIsolated(
  normalized: Parameters<typeof indexMessageChunks>[0],
  deps: {
    retrievalIndex: RetrievalIndex;
    log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
    metricsClient: Pick<typeof MetricsType, 'addMetric' | 'addDimension'>;
  },
): Promise<void> {
  const { retrievalIndex, log, metricsClient } = deps;
  try {
    await indexMessageChunks(normalized, { retrievalIndex, log, metricsClient });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Failed to embed/index WhatsApp communication chunk(s) — ingest still succeeded', {
      error: message,
    });
    metricsClient.addDimension('channel', 'whatsapp');
    metricsClient.addMetric('ChunkIndexFailed', MetricUnit.Count, 1);
  }
}

async function triggerAgentIsolated(
  input: { commId: string; accountId: string },
  deps: {
    agentTrigger: AgentTrigger;
    log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
    metricsClient: Pick<typeof MetricsType, 'addMetric' | 'addDimension'>;
  },
): Promise<void> {
  const { agentTrigger, log, metricsClient } = deps;
  try {
    await agentTrigger.publish(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Failed to publish agent trigger for WhatsApp message — ingest still succeeded', {
      commId: input.commId,
      error: message,
    });
    metricsClient.addDimension('channel', 'whatsapp');
    metricsClient.addMetric('AgentTriggerFailed', MetricUnit.Count, 1);
  }
}

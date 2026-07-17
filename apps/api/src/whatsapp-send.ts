import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  loadTwilioWhatsAppCredentials,
  sendTwilioWhatsAppMessage,
  WhatsAppConnector,
} from '@chief-of-staff/connectors/whatsapp';
import type { Connector } from '@chief-of-staff/connectors';
import { metrics } from './context.js';

/**
 * Wires the real WhatsApp send path for the API Lambda (Task 9, design.md §7): a
 * `WhatsAppConnector` constructed with `sendMessage` backed by `sendTwilioWhatsAppMessage`, the
 * same Twilio REST call the inbound webhook's send-side of the approve->send loop uses. One shared
 * client/credentials implementation (`packages/connectors/src/whatsapp/twilio-client.ts`), mirrors
 * `gmail-send.ts`'s "Lambda layer supplies the real provider call, connector stays AWS-free" split.
 *
 * `ApprovalService.approveDraft` already emits channel-agnostic `ReplySent`/`SendFailed` on every
 * successful/failed connector send — the `WhatsAppSent`/`WhatsAppSendFailed` metrics emitted here
 * (brief constraint 5) are the channel-dimensioned equivalent, mirroring how `MessageIngested` on
 * the ingest side is dimensioned by `channel` but this dashboard's per-channel WhatsApp metrics are
 * their own named counters instead (no per-metric dimensioning wired on this dashboard yet).
 */
export function createRealWhatsAppConnector(): Connector {
  return new WhatsAppConnector({
    async sendMessage(to, body) {
      try {
        const credentials = await loadTwilioWhatsAppCredentials();
        const confirmation = await sendTwilioWhatsAppMessage({ credentials, to, body });
        metrics.addMetric('WhatsAppSent', MetricUnit.Count, 1);
        return confirmation;
      } catch (error) {
        metrics.addMetric('WhatsAppSendFailed', MetricUnit.Count, 1);
        throw error;
      }
    },
  });
}

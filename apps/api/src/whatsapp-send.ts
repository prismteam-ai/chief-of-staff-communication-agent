import {
  loadTwilioWhatsAppCredentials,
  sendTwilioWhatsAppMessage,
  WhatsAppConnector,
} from '@chief-of-staff/connectors/whatsapp';
import type { Connector } from '@chief-of-staff/connectors';

/**
 * Wires the real WhatsApp send path for the API Lambda (Task 9, design.md §7): a
 * `WhatsAppConnector` constructed with `sendMessage` backed by `sendTwilioWhatsAppMessage`, the
 * same Twilio REST call the inbound webhook's send-side of the approve->send loop uses. One shared
 * client/credentials implementation (`packages/connectors/src/whatsapp/twilio-client.ts`), mirrors
 * `gmail-send.ts`'s "Lambda layer supplies the real provider call, connector stays AWS-free" split.
 */
export function createRealWhatsAppConnector(): Connector {
  return new WhatsAppConnector({
    async sendMessage(to, body) {
      const credentials = await loadTwilioWhatsAppCredentials();
      const confirmation = await sendTwilioWhatsAppMessage({ credentials, to, body });
      return confirmation;
    },
  });
}

/** `@chief-of-staff/connectors/whatsapp` — the WhatsApp (Twilio sandbox) channel connector
 * (design.md §3, docs/decisions/channel-access-tiers.md, Task 9). */
export { WhatsAppConnector } from './whatsapp-connector.js';
export type { WhatsAppSendDeps } from './whatsapp-connector.js';
export { normalizeTwilioInboundMessage } from './normalize.js';
export type { TwilioInboundPayload } from './normalize.js';
export {
  TWILIO_WHATSAPP_SECRET_ID,
  loadTwilioWhatsAppCredentials,
  verifyTwilioSignature,
  sendTwilioWhatsAppMessage,
} from './twilio-client.js';
export type { TwilioWhatsAppCredentials, TwilioSendConfirmation } from './twilio-client.js';

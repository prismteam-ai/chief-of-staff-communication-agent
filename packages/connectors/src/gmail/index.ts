/** `@chief-of-staff/connectors/gmail` — the Gmail channel connector (design.md §3, Task 3/6). */
export { GmailConnector } from './gmail-connector.js';
export type {
  GmailIngestPayload,
  GmailSendDeps,
  GmailSendConfirmation,
} from './gmail-connector.js';
export { normalizeGmailMessage } from './normalize.js';
export type { GmailMessage, GmailMessagePart } from './normalize.js';
export { buildOutboundMime } from './build-outbound-mime.js';
export {
  GMAIL_OAUTH_CLIENT_SECRET_ID,
  GMAIL_OAUTH_REDIRECT_URI,
  GMAIL_OAUTH_SCOPES,
  gmailTokenSecretId,
  loadOAuthClientCredentials,
  loadAccountRefreshToken,
  createGmailClientForAccount,
} from './gmail-client.js';
export type { GmailOAuthClientCredentials, GmailAccountToken } from './gmail-client.js';

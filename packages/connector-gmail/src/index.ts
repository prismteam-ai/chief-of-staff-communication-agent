export { backfillGmailMessages } from './backfill.js';
export type { GmailBackfillRequest, GmailBackfillResult } from './backfill.js';
export {
  createGoogleApisGmailConnector,
  type GoogleApisGmailCompositionInput,
} from './composition.js';
export { GmailConnector, GmailHistoryResetRequiredError } from './connector.js';
export {
  gmailConnectorDescriptor,
  GMAIL_AUTHORIZATION_AUDIENCE,
  GMAIL_CONNECTOR_ID,
  GMAIL_DESCRIPTOR_VERSION,
  GMAIL_OAUTH_SCOPES,
} from './descriptor.js';
export {
  GoogleApisGmailClient,
  type GmailAccountSnapshotResolver,
  type GmailApiEvidenceBoundary,
  type GmailPreparedMimeSource,
} from './googleapis-client.js';
export { gmailConnectorMetadata } from './metadata.js';
export { normalizeGmailMessage, toCanonicalEnvelope } from './normalization.js';
export { beginGmailAuthorization } from './oauth.js';
export {
  gmailProviderCorrelation,
  GMAIL_RECONCILIATION_STRATEGY,
  GMAIL_RECONCILIATION_VERSION,
  reconcileGmailEffect,
  sendGmailEffect,
} from './send.js';
export type {
  GmailConnectorDependencies,
  GmailCursorCodec,
  GmailHistoryClient,
  GmailProviderMessage,
  GmailProviderThread,
  GmailSendClient,
} from './types.js';

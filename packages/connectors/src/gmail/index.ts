/** `@chief-of-staff/connectors/gmail` — the Gmail channel connector (design.md §3, Task 3). */
export { GmailConnector } from './gmail-connector.js';
export type { GmailIngestPayload } from './gmail-connector.js';
export { normalizeGmailMessage } from './normalize.js';
export type { GmailMessage, GmailMessagePart } from './normalize.js';

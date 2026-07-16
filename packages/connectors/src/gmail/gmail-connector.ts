import type { ChannelType, NormalizedMessage } from '@chief-of-staff/shared';
import type { Connector, ConnectorEvent, ResolvedIdentity } from '../types.js';
import { normalizeGmailMessage, type GmailMessage } from './normalize.js';

/**
 * The `raw` payload a `ConnectorEvent` carries for the Gmail channel: one or more Gmail API
 * `users.messages.get` (`format=full`) responses. The processor Lambda resolves message ids from
 * the poller's SQS payload, calls `messages.get` per id, and hands the results to `ingest` — this
 * connector does no network I/O itself (brief constraint 2: "Pure logic ... unit-tested against
 * recorded Gmail-API JSON fixtures"); the Lambda layer (`apps/ingest`) owns the Gmail API calls
 * and OAuth token refresh.
 */
export interface GmailIngestPayload {
  messages: GmailMessage[];
}

function isGmailIngestPayload(raw: unknown): raw is GmailIngestPayload {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'messages' in raw &&
    Array.isArray((raw as { messages: unknown }).messages)
  );
}

/**
 * Gmail channel connector (design.md §3, brief constraint 2). `ingest` normalizes already-fetched
 * Gmail messages; `send` is deferred to Task 6 (left unimplemented per YAGNI); `identity` maps a
 * Gmail address to the internal account — trivial here because the ingest pipeline always already
 * knows the owning `accountId` (one Gmail mailbox per account, resolved by the poller from the
 * accounts table), so this simply echoes it back rather than performing a lookup of its own.
 */
export class GmailConnector implements Connector {
  readonly channelType: ChannelType = 'gmail';

  async ingest(event: ConnectorEvent): Promise<NormalizedMessage[]> {
    if (!isGmailIngestPayload(event.raw)) {
      throw new Error(
        'GmailConnector.ingest expects event.raw = { messages: GmailMessage[] } (already-fetched users.messages.get responses)',
      );
    }

    return event.raw.messages.map((message) => normalizeGmailMessage(message, event.accountId));
  }

  // `send` intentionally omitted — Task 6 implements Gmail send (In-Reply-To/References
  // threading) against the `gmail.send` scope requested by `just gmail-auth` today so no
  // re-consent is needed then.

  async identity(_participantId: string, accountId: string): Promise<ResolvedIdentity> {
    // The ingest pipeline resolves accountId from the accounts table (one row per connected
    // Gmail mailbox) before ever calling into the connector, so identity resolution for Gmail is
    // an echo, not a lookup. A future multi-address-per-account scenario (e.g. aliases) would
    // extend this to consult the accounts table directly.
    return { accountId };
  }
}

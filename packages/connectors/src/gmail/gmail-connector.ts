import type { ChannelType, NormalizedMessage } from '@chief-of-staff/shared';
import type {
  Connector,
  ConnectorEvent,
  OutboundMessage,
  ResolvedIdentity,
  SendResult,
} from '../types.js';
import { normalizeGmailMessage, type GmailMessage } from './normalize.js';
import { buildOutboundMime } from './build-outbound-mime.js';

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

/** Provider-side confirmation of a raw MIME send — the shape `gmail.users.messages.send` returns. */
export interface GmailSendConfirmation {
  id: string;
}

/**
 * Send-side dependencies, injected the same way `apps/ingest/src/processor-logic.ts` injects
 * `fetchMessage`/`fetchAttachment`: `GmailConnector` stays pure/AWS-free (brief constraint 2 — "no
 * network I/O itself"), and the Lambda layer (`apps/api`) supplies the real Gmail API call + Secrets
 * Manager-backed OAuth client via `createGmailClientForAccount` (`apps/ingest/src/gmail-client.ts`,
 * reused as-is — same secret, same `gmail.send` scope already requested by `just gmail-auth`).
 */
export interface GmailSendDeps {
  /** Calls `gmail.users.messages.send({userId: 'me', requestBody: {raw, threadId}})`. */
  sendRawMessage: (
    accountId: string,
    rawBase64Url: string,
    threadId: string,
  ) => Promise<GmailSendConfirmation>;
  /** Resolves the connected mailbox's own address (the `From:` header) for one account. */
  resolveFromAddress: (accountId: string) => Promise<string>;
}

/**
 * Gmail channel connector (design.md §3, brief constraint 2). `ingest` normalizes already-fetched
 * Gmail messages; `send` builds RFC2822 `In-Reply-To`/`References` threading (Task 6) and hands the
 * raw MIME to the injected `sendRawMessage` dependency — the actual `gmail.send`-scoped API call
 * lives in the Lambda layer, not here, mirroring the ingest side's `fetchMessage`/`fetchAttachment`
 * DI. `identity` maps a Gmail address to the internal account — trivial here because the ingest
 * pipeline always already knows the owning `accountId` (one Gmail mailbox per account, resolved by
 * the poller from the accounts table), so this simply echoes it back rather than performing a
 * lookup of its own.
 */
export class GmailConnector implements Connector {
  readonly channelType: ChannelType = 'gmail';

  constructor(private readonly sendDeps?: GmailSendDeps) {}

  async ingest(event: ConnectorEvent): Promise<NormalizedMessage[]> {
    if (!isGmailIngestPayload(event.raw)) {
      throw new Error(
        'GmailConnector.ingest expects event.raw = { messages: GmailMessage[] } (already-fetched users.messages.get responses)',
      );
    }

    return event.raw.messages.map((message) => normalizeGmailMessage(message, event.accountId));
  }

  /**
   * Sends a reply through Gmail with RFC2822 threading (design.md §7). Gmail is always advertised
   * as sendable (`channel-access-tiers.md`: Gmail is a "Live" channel) — a `GmailConnector`
   * constructed without `sendDeps` (e.g. the ingest-side `new GmailConnector()` in
   * `processor-logic.ts`, which never sends) still exposes `send`, but calling it without deps
   * throws a clear configuration error rather than silently no-op'ing.
   */
  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.sendDeps) {
      throw new Error(
        'GmailConnector.send called without sendDeps (sendRawMessage/resolveFromAddress) — ' +
          'construct with new GmailConnector({ sendRawMessage, resolveFromAddress }) to send.',
      );
    }

    const fromAddress = await this.sendDeps.resolveFromAddress(message.accountId);
    const raw = buildOutboundMime(message, fromAddress);
    const confirmation = await this.sendDeps.sendRawMessage(
      message.accountId,
      raw,
      message.threadKey,
    );

    return { providerMessageId: confirmation.id };
  }

  async identity(_participantId: string, accountId: string): Promise<ResolvedIdentity> {
    // The ingest pipeline resolves accountId from the accounts table (one row per connected
    // Gmail mailbox) before ever calling into the connector, so identity resolution for Gmail is
    // an echo, not a lookup. A future multi-address-per-account scenario (e.g. aliases) would
    // extend this to consult the accounts table directly.
    return { accountId };
  }
}

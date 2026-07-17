import type { ChannelType, NormalizedMessage } from '@chief-of-staff/shared';
import type {
  Connector,
  ConnectorEvent,
  OutboundMessage,
  ResolvedIdentity,
  SendResult,
} from '../types.js';
import { normalizeTwilioInboundMessage } from './normalize.js';

/**
 * The `raw` payload a `ConnectorEvent` carries for the WhatsApp channel: one already-received
 * Twilio inbound webhook payload (form-decoded into a plain object). Unlike Gmail's poller (which
 * fetches messages proactively), Twilio pushes each WhatsApp message to our webhook directly —
 * `ingest` normalizes exactly one delivery per call (design.md §3, brief constraint 3: "inbound-
 * webhook driven").
 */
function isTwilioRaw(raw: unknown): raw is Record<string, string> {
  return typeof raw === 'object' && raw !== null;
}

/** Send-side dependency, injected the same way `GmailConnector` takes `sendRawMessage` — keeps
 * this connector pure/AWS-free; the Lambda layer (`apps/api`) supplies the real Twilio REST call. */
export interface WhatsAppSendDeps {
  sendMessage: (to: string, body: string) => Promise<{ sid: string; status: string }>;
}

/**
 * WhatsApp channel connector via the Twilio sandbox (design.md §3, docs/decisions/channel-access-
 * tiers.md's Sandbox tier, brief constraints 2). `ingest` normalizes one already-verified Twilio
 * webhook delivery; `send` posts a reply through Twilio's Messages API. `identity` maps every
 * WhatsApp participant onto the single demo sandbox account (`acct-whatsapp-sandbox`) — this
 * sandbox has exactly one Twilio number and one connected account for the whole demo, so there is
 * no per-participant lookup to perform (mirrors Gmail's identity echo for the same reason: the
 * ingest pipeline already knows the owning `accountId` before calling in).
 */
export class WhatsAppConnector implements Connector {
  readonly channelType: ChannelType = 'whatsapp';

  constructor(private readonly sendDeps?: WhatsAppSendDeps) {}

  async ingest(event: ConnectorEvent): Promise<NormalizedMessage[]> {
    if (!isTwilioRaw(event.raw)) {
      throw new Error(
        'WhatsAppConnector.ingest expects event.raw = a Twilio inbound webhook payload (form-decoded object)',
      );
    }
    return [normalizeTwilioInboundMessage(event.raw, event.accountId)];
  }

  /**
   * Sends a reply through the Twilio WhatsApp sandbox (design.md §7, brief constraint 2). A
   * `WhatsAppConnector` constructed without `sendDeps` (e.g. an ingest-side instance that never
   * sends) still exposes `send`, but calling it without deps throws a clear configuration error
   * rather than silently no-op'ing — same posture as `GmailConnector.send`.
   */
  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.sendDeps) {
      throw new Error(
        'WhatsAppConnector.send called without sendDeps (sendMessage) — construct with ' +
          'new WhatsAppConnector({ sendMessage }) to send.',
      );
    }
    if (message.to.length === 0) {
      throw new Error('WhatsAppConnector.send requires at least one recipient in message.to');
    }

    // WhatsApp/Twilio has no CC/BCC or multi-recipient send concept — one message per outbound
    // send targets the thread's own contact (message.to[0], the thread's counterpart number);
    // additional entries (if ever supplied) are not addressed by this channel.
    const [to] = message.to;
    const confirmation = await this.sendDeps.sendMessage(to as string, message.body);

    return { providerMessageId: confirmation.sid };
  }

  async identity(_participantId: string, accountId: string): Promise<ResolvedIdentity> {
    // One sandbox number, one demo account for the whole WhatsApp channel (brief constraint 2) —
    // the ingest webhook always already knows accountId before calling in, so this is an echo,
    // not a lookup, exactly like GmailConnector.identity.
    return { accountId };
  }
}

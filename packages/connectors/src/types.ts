import type { ChannelType, NormalizedMessage } from '@chief-of-staff/shared';

/**
 * The channel connector interface (design.md §3): one TypeScript interface per channel —
 * `ingest` (webhook handler and/or incremental poller), optional `send`, and `identity` (map
 * provider participants to internal accounts). Every connector emits the same Zod-typed
 * `NormalizedMessage`; nothing downstream knows channel specifics. This module is **types + a
 * contract-test helper only** — no concrete connector ships in this task (Task 3 adds Gmail).
 */

/**
 * One inbound trigger for `ingest`: either a webhook delivery (`raw` holds the provider payload)
 * or a poller tick (`raw` holds provider-specific cursor/paging state). `accountId` is always the
 * internal account the event is scoped to — connectors never infer it from provider data alone.
 */
export interface ConnectorEvent {
  accountId: string;
  raw: unknown;
}

/** Result of a `send` call — provider-native id for correlating delivery confirmation later. */
export interface SendResult {
  providerMessageId: string;
}

/** A reply to send through the owning connector (design.md §7 "send via the owning connector"). */
export interface OutboundMessage {
  accountId: string;
  /** Thread key the reply belongs to (Gmail `In-Reply-To`/`References`, SMS conversation, …). */
  threadKey: string;
  /** Provider-native id of the message being replied to, when threading requires it. */
  inReplyToExternalId?: string;
  /**
   * The RFC2822 `Message-ID` header value of the message being replied to (e.g. Gmail's
   * `<foo@mail.gmail.com>`) — DISTINCT from `inReplyToExternalId` (the provider's internal id).
   * Email threading's `In-Reply-To`/`References` headers require this RFC2822 form (design.md §7:
   * "which also preserves history"); channels without an RFC2822 concept omit it.
   */
  inReplyToMessageId?: string;
  /** Subject line for channels that have one (email); ignored by channels that don't (SMS). */
  subject?: string;
  to: string[];
  body: string;
  /**
   * Caller-supplied idempotency key (design.md §7, Task 6 brief constraint 2: "a retried approval
   * doesn't double-send"). Connectors that can enforce it natively (rare) may use it; the
   * durable idempotency guarantee lives in the caller's conditional-write claim
   * (`apps/api`'s send-idempotency record), not in the connector itself.
   */
  idempotencyKey?: string;
}

/** Maps a provider-native participant identity onto the internal account it belongs to, if any. */
export interface ResolvedIdentity {
  accountId: string;
}

export interface Connector {
  readonly channelType: ChannelType;

  /**
   * Normalizes one inbound event (webhook delivery or poller batch) into zero or more
   * `NormalizedMessage`s. Must be safe to call twice with the same event — dedupe on
   * `externalId` is the ingest pipeline's job (design.md §5 "dedupe (conditional write)"), not
   * this method's, but `externalId` must be **stable** across repeated calls for the same
   * provider message so the pipeline's dedupe can work at all.
   */
  ingest(event: ConnectorEvent): Promise<NormalizedMessage[]>;

  /**
   * Sends an outbound reply through this channel. Optional — read-only channels (X, LinkedIn per
   * `docs/decisions/channel-access-tiers.md`) omit it; their recommendations route to a sendable
   * channel or export instead (design.md §7).
   */
  send?(message: OutboundMessage): Promise<SendResult>;

  /** Maps a provider-native participant id (email address, phone number, handle) to an account. */
  identity(participantId: string, accountId: string): Promise<ResolvedIdentity>;
}

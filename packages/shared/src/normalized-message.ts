import { z } from 'zod';

/**
 * `NormalizedMessage` — the one shape every channel connector emits (design.md §3). Nothing
 * downstream (ingest pipeline, RAG indexer, agent, dashboard) knows channel specifics; adding a
 * channel is adding a connector that maps provider data onto this schema.
 *
 * ## Additive-field versioning policy
 *
 * `NormalizedMessage` evolves **additively only**:
 *   1. New fields are always optional (`z.optional()`) or carry a safe `.default()`, so a message
 *      produced by an older connector still validates against a newer schema.
 *   2. `schemaVersion` records the producer's schema generation as an integer, defaulted to
 *      `CURRENT_SCHEMA_VERSION` when a producer omits it (pre-versioning connectors and hand-built
 *      fixtures still validate). Consumers may branch on `schemaVersion` if a future additive field
 *      changes default behavior, but a lower `schemaVersion` is never rejected outright.
 *   3. Existing fields are never removed, renamed, or narrowed in an incompatible way — only widened
 *      (e.g. a new enum member) or left untouched. A breaking change requires a new top-level export
 *      (e.g. `NormalizedMessageV2Schema`), never a silent redefinition of this one.
 *   4. The schema is built with `.passthrough()`-free but forward-tolerant unknown-key handling:
 *      Zod's default `strip` behavior on unrecognized fields is used deliberately at the object
 *      level (not `.strict()`) so a producer running a newer connector version that has already
 *      added a field this consumer doesn't know about yet does not fail validation — it is
 *      forward-compatible by construction, and the extra data is simply dropped by this consumer
 *      rather than rejected.
 *
 * This policy is what makes "adding a channel is adding a connector" true in practice (design.md
 * §3): a new connector can start emitting a new optional field immediately, and every existing
 * consumer keeps working unmodified.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Channel tiers per `docs/decisions/channel-access-tiers.md` — one connector interface, six channels. */
export const CHANNEL_TYPES = ['gmail', 'imap', 'sms', 'whatsapp', 'x', 'linkedin'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const ParticipantRoleSchema = z.enum(['from', 'to', 'cc', 'bcc']);

export const ParticipantSchema = z.object({
  /** Provider-native identity (email address, phone number, handle, etc.). */
  id: z.string().min(1),
  displayName: z.string().optional(),
  role: ParticipantRoleSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** Raw bytes live in the S3 raw-artifact bucket; this is the object key, not the payload. */
  s3Key: z.string().min(1),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const NormalizedMessageSchema = z.object({
  /** Additive-field schema generation; see the versioning policy above. */
  schemaVersion: z.number().int().positive().default(CURRENT_SCHEMA_VERSION),
  channelType: z.enum(CHANNEL_TYPES),
  /** Internal account this message belongs to — every record carries `accountId` (design.md §10). */
  accountId: z.string().min(1),
  /** Provider-native message id — stable across redelivery, used as the dedupe key. */
  externalId: z.string().min(1),
  /** Provider-derived thread/conversation key; preserves history across platforms (design.md §4). */
  threadKey: z.string().min(1),
  participants: z.array(ParticipantSchema).min(1),
  /** ISO-8601 timestamp of the original communication (not ingestion time). */
  ts: z.string().datetime(),
  body: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  /**
   * The channel's own RFC2822-style `Message-ID` header value (e.g. Gmail's `Message-ID:
   * <foo@mail.gmail.com>`), when the channel has one — DISTINCT from `externalId` (Gmail's
   * internal, provider-side message id used for dedupe/lookup). Threading a reply
   * (`In-Reply-To`/`References`, design.md §7) requires the RFC2822 header value, not the
   * internal id, so this is captured additively (Task 6) rather than overloading `externalId`.
   * Optional: channels without an RFC2822 concept (SMS, X, LinkedIn) simply omit it.
   */
  providerMessageIdHeader: z.string().optional(),
});

export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

/**
 * Deterministic communication id from channel + provider `externalId`. The record's identity is
 * independently derivable (no separate id-generation step), and the RAG layer mirrors this as the
 * `sourceId` its `chunk_id` is built on, so a chunk always points back at the exact communication
 * record it came from. Canonicalized here in `shared` (rather than in the ingest app) because both
 * the ingest processor and the RAG chunker must agree on it.
 */
export function commIdFor(channelType: string, externalId: string): string {
  return `${channelType}#${externalId}`;
}

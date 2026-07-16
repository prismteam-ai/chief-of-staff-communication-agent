import type {
  Attachment,
  ChannelType,
  NormalizedMessage,
  Participant,
} from '@chief-of-staff/shared';

/**
 * Twilio's inbound WhatsApp webhook payload — form-urlencoded fields POSTed to our webhook
 * (design.md §3, brief constraint 2). Field names are Twilio's own (`MessageSid`, `From`, `To`,
 * `Body`, `NumMedia`, `MediaUrl<N>`, `MediaContentType<N>`); this interface documents the subset
 * this connector depends on rather than the full Twilio field list (SmsStatus, AccountSid,
 * ProfileName, WaId, etc. are ignored — no PII beyond what NormalizedMessage already carries).
 */
export interface TwilioInboundPayload {
  /** Twilio's provider-native message id — stable across redelivery, used as the dedupe key. */
  MessageSid: string;
  /** Sender, always `whatsapp:+<E.164>` for the WhatsApp channel. */
  From: string;
  /** Recipient — our sandbox number, `whatsapp:+14155238886`. */
  To: string;
  Body?: string;
  /** Count of attached media items, as a decimal string (Twilio convention). */
  NumMedia?: string;
  [key: string]: string | undefined;
}

const CHANNEL_TYPE: ChannelType = 'whatsapp';

function isTwilioInboundPayload(raw: unknown): raw is TwilioInboundPayload {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).MessageSid === 'string' &&
    typeof (raw as Record<string, unknown>).From === 'string'
  );
}

/** Strips the `whatsapp:` protocol prefix Twilio puts on every WhatsApp-channel address, leaving
 * the bare `+<E.164>` phone number used as the participant id / thread key. */
function stripWhatsAppPrefix(address: string): string {
  return address.replace(/^whatsapp:/i, '').trim();
}

function extractParticipants(payload: TwilioInboundPayload): Participant[] {
  return [
    { id: stripWhatsAppPrefix(payload.From), role: 'from' },
    { id: stripWhatsAppPrefix(payload.To), role: 'to' },
  ];
}

/**
 * Media attachments: Twilio sends `NumMedia` (a count) plus `MediaUrl0..N-1` / `MediaContentType0..N-1`
 * indexed fields — never a nested array (form-encoding has no arrays). The URL itself is
 * Twilio-hosted and requires the account's own auth to fetch; it is captured as `s3Key` here (the
 * one field `Attachment` has for "where the bytes live") rather than inlined, since NO byte fetch
 * happens in this pure normalize step (mirrors the Gmail connector's "attachment bytes fetched by
 * the Lambda layer, not the connector" split) — the ingest webhook Lambda may fetch+persist to S3
 * later; for now the Twilio media URL itself is the retrievable reference.
 */
function extractAttachments(payload: TwilioInboundPayload, messageSid: string): Attachment[] {
  const numMedia = Number(payload.NumMedia ?? '0');
  if (!Number.isFinite(numMedia) || numMedia <= 0) return [];

  const attachments: Attachment[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = payload[`MediaUrl${i}`];
    if (!url) continue;
    const contentType = payload[`MediaContentType${i}`] ?? 'application/octet-stream';
    attachments.push({
      id: `${messageSid}-media-${i}`,
      filename: `media-${i}`,
      contentType,
      sizeBytes: 0, // Unknown until fetched — Twilio's webhook payload carries no size field.
      s3Key: url,
    });
  }
  return attachments;
}

/**
 * Normalizes one Twilio inbound WhatsApp webhook delivery into a `NormalizedMessage` (design.md
 * §3, brief constraint 2). Pure function — no network/AWS calls — unit-testable directly against
 * plain form-decoded payload objects, the same posture `normalizeGmailMessage` takes toward
 * recorded Gmail-API JSON fixtures.
 *
 * `threadKey` is the sender's phone number (per-contact threading, brief constraint 2: "threadKey
 * (per-contact: the From number)") — WhatsApp/Twilio has no separate conversation/thread id, so
 * every message from the same contact naturally groups under one thread.
 */
export function normalizeTwilioInboundMessage(raw: unknown, accountId: string): NormalizedMessage {
  if (!isTwilioInboundPayload(raw)) {
    throw new Error(
      'normalizeTwilioInboundMessage expects a Twilio inbound webhook payload with at least MessageSid and From',
    );
  }
  if (!raw.MessageSid) throw new Error('Twilio inbound payload is missing MessageSid');
  if (!raw.From) throw new Error(`Twilio message ${raw.MessageSid} is missing From`);

  const fromNumber = stripWhatsAppPrefix(raw.From);

  return {
    schemaVersion: 1,
    channelType: CHANNEL_TYPE,
    accountId,
    externalId: raw.MessageSid,
    threadKey: fromNumber,
    participants: extractParticipants(raw),
    // Twilio's webhook payload carries no message-timestamp field — ingestion time is the best
    // available signal (the webhook fires synchronously on receipt, so ingestion time and
    // provider-send time are effectively the same instant for a live WhatsApp delivery).
    ts: new Date().toISOString(),
    body: raw.Body ?? '',
    attachments: extractAttachments(raw, raw.MessageSid),
    // WhatsApp/Twilio has no RFC2822 Message-ID or Subject concept — both omitted (schema-optional,
    // per NormalizedMessage's additive-field policy).
  };
}

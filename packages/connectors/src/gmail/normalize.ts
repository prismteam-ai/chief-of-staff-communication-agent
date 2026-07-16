import type {
  Attachment,
  ChannelType,
  NormalizedMessage,
  Participant,
} from '@chief-of-staff/shared';

/**
 * Minimal shape of the Gmail API `users.messages.get` (`format=full`) response this module
 * depends on — intentionally narrower than `googleapis`' generated `gmail_v1.Schema$Message` so
 * normalization stays a pure, dependency-light function testable against plain fixture JSON
 * (brief constraint 2: "unit-tested against recorded Gmail-API JSON fixtures").
 */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: {
    size?: number;
    data?: string;
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

const CHANNEL_TYPE: ChannelType = 'gmail';

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function getHeader(payload: GmailMessagePart | undefined, name: string): string | undefined {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Depth-first walk collecting every leaf part (a part with a `body` and no nested `parts`) —
 * Gmail payloads nest `multipart/*` containers arbitrarily (see the attachment fixture's
 * `multipart/mixed` > `multipart/alternative` > leaf parts).
 */
function collectLeafParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
  if (!part) return [];
  if (!part.parts || part.parts.length === 0) return [part];
  return part.parts.flatMap((child) => collectLeafParts(child));
}

/** Body-text preference order per brief constraint 2: "body text/plain preferred". */
function extractBodyText(payload: GmailMessagePart | undefined): string {
  const leaves = collectLeafParts(payload);

  const plain = leaves.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain?.body?.data) return decodeBase64Url(plain.body.data).trim();

  const html = leaves.find((p) => p.mimeType === 'text/html' && p.body?.data);
  if (html?.body?.data) return decodeBase64Url(html.body.data).trim();

  // A non-multipart message carries its body directly on the top-level payload.
  if (payload?.body?.data && !payload.parts) return decodeBase64Url(payload.body.data).trim();

  return '';
}

/** Attachment descriptors — leaf parts carrying an `attachmentId` (the actual bytes are fetched
 * separately via `users.messages.attachments.get` and persisted to S3 by the processor, never
 * inlined into `NormalizedMessage`). */
function extractAttachments(
  payload: GmailMessagePart | undefined,
  messageId: string,
): Attachment[] {
  const leaves = collectLeafParts(payload);

  return leaves
    .filter((p) => p.body?.attachmentId && p.filename)
    .map((p, index) => ({
      id: p.body?.attachmentId ?? `${messageId}-attachment-${index}`,
      filename: p.filename ?? `attachment-${index}`,
      contentType: p.mimeType ?? 'application/octet-stream',
      sizeBytes: p.body?.size ?? 0,
      // Populated by the processor once the raw bytes are fetched and persisted to S3; a
      // placeholder key keeps this pure function free of any S3/AWS dependency (brief: Gmail
      // connector normalization is pure logic, no AWS calls). The processor overwrites this with
      // the real key before persisting the communication record — see `attachmentKey` in
      // `raw-artifact-store.ts` for the actual shape: `raw/<accountId>/<messageId>/attachments/<id>`.
      s3Key: `gmail/${messageId}/attachments/${p.body?.attachmentId}`,
    }));
}

/** Parses a `Name <email@example.com>` or bare `email@example.com` header value into id + display name. */
function parseAddress(value: string): { id: string; displayName?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (match) {
    const name = match[1] ?? '';
    const email = match[2] ?? '';
    return { id: email.trim().toLowerCase(), displayName: name.trim() || undefined };
  }
  return { id: value.trim().toLowerCase() };
}

/** Splits a header like `"A <a@x.com>, B <b@x.com>"` on top-level commas (addresses never contain commas here). */
function parseAddressList(value: string | undefined): { id: string; displayName?: string }[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseAddress);
}

function extractParticipants(payload: GmailMessagePart | undefined): Participant[] {
  const participants: Participant[] = [];

  for (const from of parseAddressList(getHeader(payload, 'From'))) {
    participants.push({ id: from.id, displayName: from.displayName, role: 'from' });
  }
  for (const to of parseAddressList(getHeader(payload, 'To'))) {
    participants.push({ id: to.id, displayName: to.displayName, role: 'to' });
  }
  for (const cc of parseAddressList(getHeader(payload, 'Cc'))) {
    participants.push({ id: cc.id, displayName: cc.displayName, role: 'cc' });
  }
  for (const bcc of parseAddressList(getHeader(payload, 'Bcc'))) {
    participants.push({ id: bcc.id, displayName: bcc.displayName, role: 'bcc' });
  }

  return participants;
}

/** Resolves the message timestamp: `internalDate` (Gmail-assigned receive epoch ms) preferred
 * over the `Date` header, since `internalDate` is Gmail-canonical and always present on real
 * messages, while a sender's `Date` header can be malformed or spoofed. */
function extractTimestamp(message: GmailMessage): string {
  if (message.internalDate) {
    const epochMs = Number(message.internalDate);
    if (!Number.isNaN(epochMs)) return new Date(epochMs).toISOString();
  }
  const dateHeader = getHeader(message.payload, 'Date');
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error(`Gmail message ${message.id ?? '(unknown id)'} has no usable timestamp`);
}

/**
 * Normalizes one Gmail API `users.messages.get` response into a `NormalizedMessage` (design.md
 * §3, brief constraint 2). Pure function — no network/AWS calls — so it is unit-testable directly
 * against recorded fixture JSON.
 */
export function normalizeGmailMessage(message: GmailMessage, accountId: string): NormalizedMessage {
  if (!message.id) throw new Error('Gmail message is missing an id');
  if (!message.threadId) throw new Error(`Gmail message ${message.id} is missing a threadId`);

  const participants = extractParticipants(message.payload);
  if (participants.length === 0) {
    throw new Error(
      `Gmail message ${message.id} has no From/To/Cc/Bcc headers to derive participants from`,
    );
  }

  return {
    schemaVersion: 1,
    channelType: CHANNEL_TYPE,
    accountId,
    externalId: message.id,
    threadKey: message.threadId,
    participants,
    ts: extractTimestamp(message),
    body: extractBodyText(message.payload),
    attachments: extractAttachments(message.payload, message.id),
  };
}

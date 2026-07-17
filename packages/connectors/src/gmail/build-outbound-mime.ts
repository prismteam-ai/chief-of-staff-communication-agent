import type { OutboundMessage } from '../types.js';

/**
 * Builds the RFC2822 message + Gmail's base64url envelope for `users.messages.send` (design.md §7
 * "Gmail API send with In-Reply-To/References threading ... which also preserves history"). Pure,
 * dependency-free string building — unit-tested directly against fixture-shaped `OutboundMessage`s
 * (`build-outbound-mime.test.ts`), same "pure logic, no AWS/network calls" discipline as
 * `normalize.ts`; the actual `gmail.users.messages.send` API call is made by the injected
 * `sendRawMessage` dependency in `gmail-connector.ts` (mirrors `fetchMessage`/`fetchAttachment` in
 * `apps/ingest/src/processor-logic.ts`).
 *
 * ## Threading: RFC2822 Message-ID, not the Gmail-internal id
 * Gmail's `In-Reply-To`/`References` headers are RFC2822 threading headers — they take the
 * `Message-ID` header VALUE of the message being replied to (e.g. `<foo@mail.gmail.com>`), which is
 * DISTINCT from Gmail's own internal message id (`externalId` elsewhere in this codebase). Using the
 * internal id here would silently fail to thread (Gmail falls back to `threadId`-only grouping,
 * which is looser and not guaranteed across clients). `OutboundMessage.inReplyToMessageId` carries
 * the RFC2822 value (populated from `NormalizedMessage.providerMessageIdHeader`, itself captured by
 * `normalize.ts`); if a caller only has the internal id (e.g. a synthetic/test record with no
 * captured header), this falls back to a best-effort synthesized Message-ID token so threading still
 * has *something* to key on rather than omitting the headers outright.
 */

function synthesizeMessageId(externalId: string): string {
  return `<${externalId}@mail.gmail.com>`;
}

/** Resolves the RFC2822 Message-ID to thread onto, preferring the real header over a synthesized one. */
function resolveInReplyTo(message: OutboundMessage): string | undefined {
  if (message.inReplyToMessageId) return message.inReplyToMessageId;
  if (message.inReplyToExternalId) return synthesizeMessageId(message.inReplyToExternalId);
  return undefined;
}

function ensureReSubject(subject: string | undefined): string {
  const base = subject ?? '(no subject)';
  return /^re:\s/i.test(base) ? base : `Re: ${base}`;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Test/debug helper — the inverse of the base64url encoding this module produces. */
export function decodeBase64UrlToUtf8(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

/**
 * Builds the base64url-encoded RFC2822 message Gmail's `users.messages.send` expects in
 * `requestBody.raw`. `fromAddress` is the sending mailbox (the connected account's own address —
 * resolved by the caller from the accounts table / OAuth identity, never guessed).
 */
export function buildOutboundMime(message: OutboundMessage, fromAddress: string): string {
  const inReplyTo = resolveInReplyTo(message);

  const headers: string[] = [
    `From: ${fromAddress}`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${ensureReSubject(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    // Single-hop References today (no multi-message chain tracked yet) — still correct per RFC
    // 2822 §3.6.4 (References SHOULD include at least the immediate parent's Message-ID).
    headers.push(`References: ${inReplyTo}`);
  }

  const mime = `${headers.join('\r\n')}\r\n\r\n${message.body}`;
  return encodeBase64Url(mime);
}

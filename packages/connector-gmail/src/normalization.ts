import type { CanonicalEnvelope } from '@chief/contracts/connectors';

import type {
  GmailHeader,
  GmailMessagePart,
  GmailNormalizedAttachment,
  GmailNormalizedMessage,
  GmailProviderMessage,
} from './types.js';

function headerValues(
  headers: readonly GmailHeader[] | undefined,
  name: string,
): readonly string[] {
  const expected = name.toLowerCase();
  return (headers ?? [])
    .filter((header) => header.name.toLowerCase() === expected)
    .map((header) => header.value);
}

function firstHeader(
  headers: readonly GmailHeader[] | undefined,
  name: string,
): string | undefined {
  return headerValues(headers, name)[0];
}

function splitAddresses(values: readonly string[]): readonly string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function decodeBase64Url(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return Buffer.from(value, 'base64url').toString('utf8');
}

function collectParts(part: GmailMessagePart): readonly GmailMessagePart[] {
  return [part, ...(part.parts ?? []).flatMap(collectParts)];
}

function normalizeAttachment(
  part: GmailMessagePart,
): GmailNormalizedAttachment | undefined {
  if (
    part.body?.attachmentId === undefined ||
    part.filename === undefined ||
    part.filename.length === 0
  ) {
    return undefined;
  }
  return {
    attachmentId: part.body.attachmentId,
    filename: part.filename,
    mimeType: part.mimeType ?? 'application/octet-stream',
    size: part.body.size ?? 0,
    ...(part.partId === undefined ? {} : { partId: part.partId }),
  };
}

function sourceTimestamp(message: GmailProviderMessage): string {
  if (message.internalDate === undefined) {
    throw new Error('GMAIL_MESSAGE_INTERNAL_DATE_REQUIRED');
  }
  const epochMilliseconds = Number(message.internalDate);
  if (!Number.isFinite(epochMilliseconds) || epochMilliseconds < 0) {
    throw new Error('GMAIL_MESSAGE_INTERNAL_DATE_INVALID');
  }
  return new Date(epochMilliseconds).toISOString();
}

export function normalizeGmailMessage(
  message: GmailProviderMessage,
): GmailNormalizedMessage {
  const parts = collectParts(message.payload);
  const headers = message.payload.headers;
  const references = (firstHeader(headers, 'References') ?? '')
    .split(/\s+/u)
    .filter((value) => value.length > 0);
  const textBody = parts
    .filter((part) => part.mimeType === 'text/plain')
    .map((part) => decodeBase64Url(part.body?.data))
    .find((body) => body !== undefined);
  const htmlBody = parts
    .filter((part) => part.mimeType === 'text/html')
    .map((part) => decodeBase64Url(part.body?.data))
    .find((body) => body !== undefined);
  const attachments = parts
    .map(normalizeAttachment)
    .filter(
      (attachment): attachment is GmailNormalizedAttachment =>
        attachment !== undefined,
    );

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    ...(message.historyId === undefined
      ? {}
      : { historyId: message.historyId }),
    sourceTimestamp: sourceTimestamp(message),
    ...(firstHeader(headers, 'From') === undefined
      ? {}
      : { from: firstHeader(headers, 'From') }),
    to: splitAddresses(headerValues(headers, 'To')),
    cc: splitAddresses(headerValues(headers, 'Cc')),
    ...(firstHeader(headers, 'Subject') === undefined
      ? {}
      : { subject: firstHeader(headers, 'Subject') }),
    ...(textBody === undefined ? {} : { textBody }),
    ...(htmlBody === undefined ? {} : { htmlBody }),
    labels: [...(message.labelIds ?? [])],
    attachments,
    reply: {
      ...(firstHeader(headers, 'Message-ID') === undefined
        ? {}
        : { messageId: firstHeader(headers, 'Message-ID') }),
      ...(firstHeader(headers, 'In-Reply-To') === undefined
        ? {}
        : { inReplyTo: firstHeader(headers, 'In-Reply-To') }),
      references,
    },
    rawBodyRef: message.rawBodyRef,
    canonicalPayloadHash: message.canonicalPayloadHash,
  };
}

export function toCanonicalEnvelope(input: {
  readonly account: CanonicalEnvelope['account'];
  readonly connectorSnapshot: CanonicalEnvelope['connectorSnapshot'];
  readonly message: GmailProviderMessage;
}): CanonicalEnvelope {
  const normalized = normalizeGmailMessage(input.message);
  return {
    schemaVersion: '1',
    account: input.account,
    providerMessageRef: {
      providerMessageId: normalized.providerMessageId,
      providerThreadId: normalized.providerThreadId,
    },
    sourceTimestamp: normalized.sourceTimestamp,
    rawBodyRef: normalized.rawBodyRef,
    canonicalPayloadHash: normalized.canonicalPayloadHash,
    attachmentCount: normalized.attachments.length,
    connectorSnapshot: input.connectorSnapshot,
  };
}

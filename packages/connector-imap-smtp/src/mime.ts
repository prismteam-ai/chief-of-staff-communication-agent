import { createHash } from 'node:crypto';

import { simpleParser } from 'mailparser';

export interface NormalizedMailboxAddress {
  readonly name?: string;
  readonly address: string;
}

export interface NormalizedMimeAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly contentId?: string;
  readonly size: number;
  readonly sha256: string;
  readonly content: Uint8Array;
}

export interface NormalizedMimeMessage {
  readonly rawSha256: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly threadRootMessageId: string;
  readonly subject: string;
  readonly from: readonly NormalizedMailboxAddress[];
  readonly to: readonly NormalizedMailboxAddress[];
  readonly cc: readonly NormalizedMailboxAddress[];
  readonly replyTo: readonly NormalizedMailboxAddress[];
  readonly sentAt?: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments: readonly NormalizedMimeAttachment[];
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeMessageId(value: string): string {
  const trimmed = value.trim();
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(trimmed)) {
    throw new Error('RFC5322_MESSAGE_ID_INVALID');
  }
  return trimmed;
}

function normalizeAddresses(
  values:
    | readonly { readonly name?: string; readonly address?: string }[]
    | undefined,
): readonly NormalizedMailboxAddress[] {
  return (values ?? [])
    .flatMap((value) => {
      const address = value.address?.trim().toLowerCase();
      if (address === undefined || address.length === 0) {
        return [];
      }
      return [
        value.name === undefined || value.name.trim().length === 0
          ? { address }
          : { name: value.name.trim(), address },
      ];
    })
    .sort((left, right) => left.address.localeCompare(right.address));
}

function normalizeReferences(
  references: string | readonly string[] | undefined,
): readonly string[] {
  const values =
    references === undefined
      ? []
      : typeof references === 'string'
        ? references.split(/\s+/u)
        : [...references];
  return [
    ...new Set(
      values.filter((value) => value.trim().length > 0).map(normalizeMessageId),
    ),
  ];
}

function addressValues(
  input:
    | {
        readonly value: readonly {
          readonly name?: string;
          readonly address?: string;
        }[];
      }
    | readonly {
        readonly value: readonly {
          readonly name?: string;
          readonly address?: string;
        }[];
      }[]
    | undefined,
): readonly { readonly name?: string; readonly address?: string }[] {
  if (input === undefined) {
    return [];
  }
  if ('value' in input) {
    return input.value;
  }
  return input.flatMap((addressObject) => addressObject.value);
}

export async function parseMimeMessage(
  raw: Uint8Array | string,
): Promise<NormalizedMimeMessage> {
  const source =
    typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
  const parsed = await simpleParser(source, {
    skipImageLinks: true,
    skipHtmlToText: true,
  });
  if (parsed.messageId === undefined) {
    throw new Error('RFC5322_MESSAGE_ID_REQUIRED');
  }
  const messageId = normalizeMessageId(parsed.messageId);
  const references = normalizeReferences(parsed.references);
  const rawInReplyTo: unknown = parsed.inReplyTo;
  const inReplyTo =
    rawInReplyTo === undefined
      ? undefined
      : normalizeMessageId(
          typeof rawInReplyTo === 'string'
            ? rawInReplyTo
            : Array.isArray(rawInReplyTo) && typeof rawInReplyTo[0] === 'string'
              ? rawInReplyTo[0]
              : '',
        );
  const threadRootMessageId = references[0] ?? inReplyTo ?? messageId;
  const attachments = parsed.attachments
    .map((attachment, index): NormalizedMimeAttachment => ({
      fileName: attachment.filename?.trim() || `attachment-${index + 1}`,
      contentType: attachment.contentType.toLowerCase(),
      contentDisposition:
        attachment.contentDisposition?.toLowerCase() ?? 'attachment',
      ...(attachment.cid === undefined ? {} : { contentId: attachment.cid }),
      size: attachment.size,
      sha256: sha256(attachment.content),
      content: Uint8Array.from(attachment.content),
    }))
    .sort((left, right) =>
      `${left.fileName}\u0000${left.sha256}`.localeCompare(
        `${right.fileName}\u0000${right.sha256}`,
      ),
    );

  return {
    rawSha256: sha256(source),
    messageId,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
    threadRootMessageId,
    subject: parsed.subject?.trim() ?? '',
    from: normalizeAddresses(parsed.from?.value),
    to: normalizeAddresses(addressValues(parsed.to)),
    cc: normalizeAddresses(addressValues(parsed.cc)),
    replyTo: normalizeAddresses(parsed.replyTo?.value),
    ...(parsed.date === undefined ? {} : { sentAt: parsed.date.toISOString() }),
    text: parsed.text?.replace(/\r\n/gu, '\n').trimEnd() ?? '',
    ...(typeof parsed.html === 'string'
      ? { html: parsed.html.replace(/\r\n/gu, '\n').trim() }
      : {}),
    attachments,
  };
}

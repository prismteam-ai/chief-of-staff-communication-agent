import type {
  CanonicalEnvelope,
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';

import type {
  GraphAttachment,
  GraphMessage,
  GraphRecipient,
} from './graph-types.js';
import { sha256 } from './hash.js';

export interface NormalizedGraphAttachment {
  readonly providerAttachmentId: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly isInline: boolean;
  readonly contentId?: string;
  readonly contentSha256?: string;
}

export interface NormalizedGraphMessage {
  readonly immutableMessageId: string;
  readonly conversationId: string;
  readonly internetMessageId?: string;
  readonly subject: string;
  readonly body: { readonly kind: 'text' | 'html'; readonly content: string };
  readonly bodyPreview: string;
  readonly from?: string;
  readonly sender?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: readonly string[];
  readonly sourceTimestamp: string;
  readonly isDraft: boolean;
  readonly isRead: boolean;
  readonly attachments: readonly NormalizedGraphAttachment[];
  readonly replyHeaders: Readonly<{
    inReplyTo?: string;
    references: readonly string[];
  }>;
  readonly canonicalPayloadHash: string;
}

export interface GraphNormalizationContext {
  readonly account: ConnectorAccountRef;
  readonly snapshot: ConnectorSnapshot;
  readonly rawBodyRef: string;
}

export function normalizeGraphMessage(
  message: GraphMessage,
  context: GraphNormalizationContext,
): {
  readonly envelope: CanonicalEnvelope;
  readonly message: NormalizedGraphMessage;
} {
  const immutableMessageId = message.id;
  const sourceTimestamp =
    message.receivedDateTime ??
    message.sentDateTime ??
    message.lastModifiedDateTime;
  const attachments = (message.attachments ?? []).map(normalizeAttachment);
  const replyHeaders = normalizeReplyHeaders(
    message.internetMessageHeaders ?? [],
  );
  const canonicalPayloadHash = sha256(
    JSON.stringify({
      immutableMessageId,
      conversationId: message.conversationId,
      internetMessageId: message.internetMessageId ?? null,
      subject: message.subject,
      body: message.body,
      from: recipientAddress(message.from),
      sender: recipientAddress(message.sender),
      to: message.toRecipients.map(requiredRecipientAddress),
      cc: message.ccRecipients.map(requiredRecipientAddress),
      bcc: message.bccRecipients.map(requiredRecipientAddress),
      replyTo: message.replyTo.map(requiredRecipientAddress),
      sourceTimestamp,
      isDraft: message.isDraft,
      isRead: message.isRead,
      attachments,
      replyHeaders,
    }),
  );
  const normalized: NormalizedGraphMessage = {
    immutableMessageId,
    conversationId: message.conversationId,
    ...(message.internetMessageId === undefined
      ? {}
      : { internetMessageId: message.internetMessageId }),
    subject: message.subject,
    body: { kind: message.body.contentType, content: message.body.content },
    bodyPreview: message.bodyPreview,
    ...(recipientAddress(message.from) === undefined
      ? {}
      : { from: recipientAddress(message.from) }),
    ...(recipientAddress(message.sender) === undefined
      ? {}
      : { sender: recipientAddress(message.sender) }),
    to: message.toRecipients.map(requiredRecipientAddress),
    cc: message.ccRecipients.map(requiredRecipientAddress),
    bcc: message.bccRecipients.map(requiredRecipientAddress),
    replyTo: message.replyTo.map(requiredRecipientAddress),
    sourceTimestamp,
    isDraft: message.isDraft,
    isRead: message.isRead,
    attachments,
    replyHeaders,
    canonicalPayloadHash,
  };
  return {
    message: normalized,
    envelope: {
      schemaVersion: '1',
      account: context.account,
      providerMessageRef: {
        providerMessageId: immutableMessageId,
        providerThreadId: message.conversationId,
      },
      sourceTimestamp,
      rawBodyRef: context.rawBodyRef,
      canonicalPayloadHash,
      attachmentCount: attachments.length,
      connectorSnapshot: context.snapshot,
    },
  };
}

function normalizeAttachment(
  attachment: GraphAttachment,
): NormalizedGraphAttachment {
  return {
    providerAttachmentId: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    isInline: attachment.isInline,
    ...(attachment.contentId === undefined
      ? {}
      : { contentId: attachment.contentId }),
    ...(attachment.contentBytes === undefined
      ? {}
      : {
          contentSha256: sha256(Buffer.from(attachment.contentBytes, 'base64')),
        }),
  };
}

function normalizeReplyHeaders(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): { readonly inReplyTo?: string; readonly references: readonly string[] } {
  const values = new Map(
    headers.map((header) => [header.name.toLowerCase(), header.value.trim()]),
  );
  const inReplyTo = values.get('in-reply-to');
  const references = (values.get('references') ?? '')
    .split(/\s+/u)
    .filter((value) => value.length > 0);
  return {
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
  };
}

function recipientAddress(
  recipient: GraphRecipient | undefined,
): string | undefined {
  return recipient?.emailAddress.address.trim().toLowerCase();
}

function requiredRecipientAddress(recipient: GraphRecipient): string {
  const value = recipientAddress(recipient);
  if (value === undefined || value.length === 0) {
    throw new Error('GRAPH_RECIPIENT_ADDRESS_MISSING');
  }
  return value;
}

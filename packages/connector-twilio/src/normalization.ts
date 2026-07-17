import { createHash } from 'node:crypto';

import type { VerifiedProviderEvent } from '@chief/contracts/connectors';

import type { ParsedTwilioWebhook, TwilioFormFields } from './signature.js';
import type { TwilioChannel } from './channels.js';

export interface TwilioMediaAttachment {
  readonly index: number;
  readonly providerAttachmentId: string;
  readonly mediaUrl: string;
  readonly contentType: string;
  readonly fetchPolicy: 'never_in_connector';
}

export interface TwilioInboundMessage {
  readonly kind: 'inbound_message';
  readonly channel: TwilioChannel;
  readonly messageSid: string;
  readonly accountSid?: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly optOutType?: 'START' | 'STOP' | 'HELP';
  readonly media: readonly TwilioMediaAttachment[];
  readonly providerThreadId: string;
  readonly rawPayloadDigest: string;
  readonly rawFields: TwilioFormFields;
  readonly sourceTimestamp: string;
  readonly sourceTimestampFact: 'provider' | 'verified_ingress_fallback';
}

export type TwilioRawMessageStatus =
  | 'accepted'
  | 'scheduled'
  | 'canceled'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'delivered'
  | 'undelivered'
  | 'receiving'
  | 'received'
  | 'read';

export interface TwilioStatusCallback {
  readonly kind: 'status_callback';
  readonly channel: TwilioChannel;
  readonly messageSid: string;
  readonly accountSid?: string;
  readonly rawStatus: TwilioRawMessageStatus;
  readonly errorCode?: string;
  readonly channelStatusMessage?: string;
  readonly rawDlrDoneDate?: string;
  readonly rawPayloadDigest: string;
  readonly rawFields: TwilioFormFields;
  readonly sourceTimestamp: string;
  readonly sourceTimestampFact: 'provider' | 'verified_ingress_fallback';
}

export type TwilioProviderEvent = TwilioInboundMessage | TwilioStatusCallback;

function single(
  fields: TwilioFormFields,
  name: string,
  required = false,
): string | undefined {
  const value = fields[name];
  if (typeof value !== 'string' && value !== undefined) {
    throw new Error(`TWILIO_DUPLICATE_${name.toUpperCase()}`);
  }
  if (required && (value === undefined || value.length === 0)) {
    throw new Error(`TWILIO_${name.toUpperCase()}_MISSING`);
  }
  return value;
}

function assertMessageSid(value: string): string {
  if (!/^(?:SM|MM)[0-9a-fA-F]{32}$/u.test(value)) {
    throw new Error('TWILIO_MESSAGE_SID_INVALID');
  }
  return value;
}

function assertChannelAddress(value: string, channel: TwilioChannel): string {
  const whatsapp = value.startsWith('whatsapp:');
  if ((channel === 'whatsapp') !== whatsapp) {
    throw new Error('TWILIO_CHANNEL_ADDRESS_MISMATCH');
  }
  return value;
}

function parseTimestamp(
  fields: TwilioFormFields,
  fallback: string,
): readonly [string, 'provider' | 'verified_ingress_fallback'] {
  const candidate = single(fields, 'Timestamp');
  if (candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
    return [new Date(candidate).toISOString(), 'provider'];
  }
  return [fallback, 'verified_ingress_fallback'];
}

function providerThreadId(
  channel: TwilioChannel,
  from: string,
  to: string,
): string {
  const participants = [from, to].sort().join('\u0000');
  return `twilio-thread:${createHash('sha256')
    .update(`${channel}\u0000${participants}`)
    .digest('hex')}`;
}

function parseMedia(
  fields: TwilioFormFields,
  messageSid: string,
): readonly TwilioMediaAttachment[] {
  const countRaw = single(fields, 'NumMedia') ?? '0';
  if (!/^\d{1,2}$/u.test(countRaw)) {
    throw new Error('TWILIO_MEDIA_COUNT_INVALID');
  }
  const count = Number.parseInt(countRaw, 10);
  if (count > 10) {
    throw new Error('TWILIO_MEDIA_COUNT_EXCEEDED');
  }
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const mediaUrl = single(fields, `MediaUrl${index}`, true);
      const contentType = single(fields, `MediaContentType${index}`, true);
      if (mediaUrl === undefined || contentType === undefined) {
        throw new Error('TWILIO_MEDIA_FIELDS_INCOMPLETE');
      }
      const parsedUrl = new URL(mediaUrl);
      if (parsedUrl.protocol !== 'https:') {
        throw new Error('TWILIO_MEDIA_URL_NOT_HTTPS');
      }
      return Object.freeze({
        index,
        providerAttachmentId: `${messageSid}:media:${index}`,
        mediaUrl,
        contentType,
        fetchPolicy: 'never_in_connector' as const,
      });
    }),
  );
}

const statuses = new Set<TwilioRawMessageStatus>([
  'accepted',
  'scheduled',
  'canceled',
  'queued',
  'sending',
  'sent',
  'failed',
  'delivered',
  'undelivered',
  'receiving',
  'received',
  'read',
]);

export function classifyTwilioChannel(fields: TwilioFormFields): TwilioChannel {
  const from = single(fields, 'From');
  const to = single(fields, 'To');
  return from?.startsWith('whatsapp:') === true ||
    to?.startsWith('whatsapp:') === true
    ? 'whatsapp'
    : 'sms';
}

export function twilioProviderEventId(parsed: ParsedTwilioWebhook): string {
  const messageSid = single(parsed.fields, 'MessageSid', true);
  if (messageSid === undefined) {
    throw new Error('TWILIO_MESSAGE_SID_MISSING');
  }
  assertMessageSid(messageSid);
  const status = single(parsed.fields, 'MessageStatus');
  return status === undefined
    ? messageSid
    : `twilio-status:${messageSid}:${parsed.rawPayloadDigest}`;
}

export function normalizeTwilioProviderEvent(input: {
  readonly parsed: ParsedTwilioWebhook;
  readonly verifiedEvent: Pick<VerifiedProviderEvent, 'verifiedAt'>;
  readonly expectedChannel: TwilioChannel;
}): TwilioProviderEvent {
  const fields = input.parsed.fields;
  const actualChannel = classifyTwilioChannel(fields);
  if (actualChannel !== input.expectedChannel) {
    throw new Error('TWILIO_CHANNEL_MISMATCH');
  }
  const messageSidValue = single(fields, 'MessageSid', true);
  if (messageSidValue === undefined) {
    throw new Error('TWILIO_MESSAGE_SID_MISSING');
  }
  const messageSid = assertMessageSid(messageSidValue);
  const accountSid = single(fields, 'AccountSid');
  const [sourceTimestamp, sourceTimestampFact] = parseTimestamp(
    fields,
    input.verifiedEvent.verifiedAt,
  );
  const statusValue = single(fields, 'MessageStatus');
  if (statusValue !== undefined) {
    if (!statuses.has(statusValue as TwilioRawMessageStatus)) {
      throw new Error('TWILIO_MESSAGE_STATUS_UNKNOWN');
    }
    return Object.freeze({
      kind: 'status_callback',
      channel: actualChannel,
      messageSid,
      ...(accountSid === undefined ? {} : { accountSid }),
      rawStatus: statusValue as TwilioRawMessageStatus,
      ...(single(fields, 'ErrorCode') === undefined
        ? {}
        : { errorCode: single(fields, 'ErrorCode') }),
      ...(single(fields, 'ChannelStatusMessage') === undefined
        ? {}
        : { channelStatusMessage: single(fields, 'ChannelStatusMessage') }),
      ...(single(fields, 'RawDlrDoneDate') === undefined
        ? {}
        : { rawDlrDoneDate: single(fields, 'RawDlrDoneDate') }),
      rawPayloadDigest: input.parsed.rawPayloadDigest,
      rawFields: fields,
      sourceTimestamp,
      sourceTimestampFact,
    });
  }
  const fromValue = single(fields, 'From', true);
  const toValue = single(fields, 'To', true);
  if (fromValue === undefined || toValue === undefined) {
    throw new Error('TWILIO_PARTICIPANT_MISSING');
  }
  const from = assertChannelAddress(fromValue, actualChannel);
  const to = assertChannelAddress(toValue, actualChannel);
  const optOut = single(fields, 'OptOutType');
  if (
    optOut !== undefined &&
    optOut !== 'START' &&
    optOut !== 'STOP' &&
    optOut !== 'HELP'
  ) {
    throw new Error('TWILIO_OPT_OUT_TYPE_UNKNOWN');
  }
  return Object.freeze({
    kind: 'inbound_message',
    channel: actualChannel,
    messageSid,
    ...(accountSid === undefined ? {} : { accountSid }),
    from,
    to,
    body: single(fields, 'Body') ?? '',
    ...(optOut === undefined ? {} : { optOutType: optOut }),
    media: parseMedia(fields, messageSid),
    providerThreadId: providerThreadId(actualChannel, from, to),
    rawPayloadDigest: input.parsed.rawPayloadDigest,
    rawFields: fields,
    sourceTimestamp,
    sourceTimestampFact,
  });
}

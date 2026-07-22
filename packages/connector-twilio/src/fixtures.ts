import { rawWebhookRequestSchema } from '@chief/contracts/connectors';
import type { RawWebhookRequest } from '@chief/contracts/connectors';

import { signTwilioFixtureRequest } from './signature.js';

export const TWILIO_FIXTURE_OBSERVED_AT = '2026-07-17T12:00:00.000Z';
export const TWILIO_FIXTURE_URLS = Object.freeze({
  sms: 'https://callbacks.example.invalid/twilio/sms?stage=wave1b&tenant=fixture',
  whatsapp:
    'https://callbacks.example.invalid/twilio/whatsapp?stage=wave1b&tenant=fixture',
});

function form(entries: readonly (readonly [string, string])[]): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of entries) {
    parameters.append(name, value);
  }
  return parameters.toString();
}

export const twilioProviderBodies = Object.freeze({
  smsInboundMedia: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['ApiVersion', '2010-04-01'],
    ['MessageSid', 'MM11111111111111111111111111111111'],
    ['SmsMessageSid', 'MM11111111111111111111111111111111'],
    ['SmsSid', 'MM11111111111111111111111111111111'],
    ['SmsStatus', 'received'],
    ['From', '+15550000001'],
    ['To', '+15550000002'],
    ['Body', 'Provider-shaped MMS fixture'],
    ['NumMedia', '2'],
    ['MediaUrl0', 'https://api.example.invalid/media/ME000'],
    ['MediaContentType0', 'image/png'],
    ['MediaUrl1', 'https://api.example.invalid/media/ME001'],
    ['MediaContentType1', 'application/pdf'],
    ['Timestamp', '2026-07-17T11:59:58.000Z'],
  ]),
  smsStop: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM22222222222222222222222222222222'],
    ['From', '+15550000001'],
    ['To', '+15550000002'],
    ['Body', 'STOP'],
    ['OptOutType', 'STOP'],
    ['NumMedia', '0'],
    ['Timestamp', '2026-07-17T12:01:00.000Z'],
  ]),
  smsStart: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM33333333333333333333333333333333'],
    ['From', '+15550000001'],
    ['To', '+15550000002'],
    ['Body', 'START'],
    ['OptOutType', 'START'],
    ['NumMedia', '0'],
    ['Timestamp', '2026-07-17T12:02:00.000Z'],
  ]),
  smsBodyOnlyStop: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM44444444444444444444444444444444'],
    ['From', '+15550000001'],
    ['To', '+15550000002'],
    ['Body', 'STOP'],
    ['NumMedia', '0'],
    ['Timestamp', '2026-07-17T12:03:00.000Z'],
  ]),
  smsStatusQueued: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM55555555555555555555555555555555'],
    ['MessageStatus', 'queued'],
    ['From', '+15550000002'],
    ['To', '+15550000001'],
    ['Timestamp', '2026-07-17T12:04:00.000Z'],
  ]),
  smsStatusSent: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM55555555555555555555555555555555'],
    ['MessageStatus', 'sent'],
    ['From', '+15550000002'],
    ['To', '+15550000001'],
    ['Timestamp', '2026-07-17T12:05:00.000Z'],
  ]),
  smsStatusDelivered: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM55555555555555555555555555555555'],
    ['MessageStatus', 'delivered'],
    ['From', '+15550000002'],
    ['To', '+15550000001'],
    ['RawDlrDoneDate', '2607171206'],
    ['Timestamp', '2026-07-17T12:06:00.000Z'],
  ]),
  smsStatusUndelivered: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM55555555555555555555555555555555'],
    ['MessageStatus', 'undelivered'],
    ['ErrorCode', '30003'],
    ['From', '+15550000002'],
    ['To', '+15550000001'],
    ['Timestamp', '2026-07-17T12:07:00.000Z'],
  ]),
  whatsappInbound: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM66666666666666666666666666666666'],
    ['From', 'whatsapp:+15550000001'],
    ['To', 'whatsapp:+14155238886'],
    ['Body', 'I explicitly consent to WhatsApp updates'],
    ['NumMedia', '0'],
    ['Timestamp', '2026-07-17T12:08:00.000Z'],
  ]),
  whatsappStatusRead: form([
    ['AccountSid', 'AC00000000000000000000000000000000'],
    ['MessageSid', 'SM77777777777777777777777777777777'],
    ['MessageStatus', 'read'],
    ['ChannelPrefix', 'whatsapp'],
    ['From', 'whatsapp:+14155238886'],
    ['To', 'whatsapp:+15550000001'],
    ['Timestamp', '2026-07-17T12:09:00.000Z'],
  ]),
});

export function createTwilioSignedFixtureRequest(input: {
  readonly channel: 'sms' | 'whatsapp';
  readonly rawBody: string;
  readonly signingKey: string;
  readonly providerVisibleUrl?: string;
  readonly receivedAt?: string;
}): RawWebhookRequest {
  const providerVisibleUrl =
    input.providerVisibleUrl ?? TWILIO_FIXTURE_URLS[input.channel];
  const signature = signTwilioFixtureRequest({
    providerVisibleUrl,
    rawBody: input.rawBody,
    signingKey: input.signingKey,
  });
  return rawWebhookRequestSchema.parse({
    method: 'POST',
    providerVisibleUrl,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'x-twilio-signature': signature,
    },
    rawBodyBase64: Buffer.from(input.rawBody, 'utf8').toString('base64'),
    receivedAt: input.receivedAt ?? TWILIO_FIXTURE_OBSERVED_AT,
  });
}

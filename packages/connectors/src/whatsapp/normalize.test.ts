import { describe, expect, it } from 'vitest';
import { NormalizedMessageSchema } from '@chief-of-staff/shared';
import { normalizeTwilioInboundMessage } from './normalize.js';

const ACCOUNT_ID = 'acct-whatsapp-sandbox';

function inboundPayload(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SM1234567890abcdef1234567890abcdef',
    AccountSid: 'ACfake00000000000000000000000000fake',
    From: 'whatsapp:+15551234567',
    To: 'whatsapp:+14155238886',
    Body: 'Can we push the Thursday sync to 3pm?',
    NumMedia: '0',
    ...overrides,
  };
}

describe('normalizeTwilioInboundMessage', () => {
  it('normalizes a simple inbound WhatsApp message into a schema-valid NormalizedMessage', () => {
    const result = normalizeTwilioInboundMessage(inboundPayload(), ACCOUNT_ID);

    expect(NormalizedMessageSchema.safeParse(result).success).toBe(true);
    expect(result.channelType).toBe('whatsapp');
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.externalId).toBe('SM1234567890abcdef1234567890abcdef');
    expect(result.body).toBe('Can we push the Thursday sync to 3pm?');
  });

  it('strips the whatsapp: prefix and uses the bare From number as threadKey (per-contact threading)', () => {
    const result = normalizeTwilioInboundMessage(inboundPayload(), ACCOUNT_ID);

    expect(result.threadKey).toBe('+15551234567');
  });

  it('derives from/to participants with the whatsapp: prefix stripped', () => {
    const result = normalizeTwilioInboundMessage(inboundPayload(), ACCOUNT_ID);

    expect(result.participants).toEqual([
      { id: '+15551234567', role: 'from' },
      { id: '+14155238886', role: 'to' },
    ]);
  });

  it('produces no attachments when NumMedia is 0', () => {
    const result = normalizeTwilioInboundMessage(inboundPayload(), ACCOUNT_ID);

    expect(result.attachments).toEqual([]);
  });

  it('captures media attachments when NumMedia > 0', () => {
    const payload = inboundPayload({
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/media/ME1',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/media/ME2',
      MediaContentType1: 'application/pdf',
    });

    const result = normalizeTwilioInboundMessage(payload, ACCOUNT_ID);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]).toMatchObject({
      contentType: 'image/jpeg',
      s3Key: 'https://api.twilio.com/media/ME1',
    });
    expect(result.attachments[1]).toMatchObject({
      contentType: 'application/pdf',
      s3Key: 'https://api.twilio.com/media/ME2',
    });
  });

  it('defaults body to empty string for a media-only message (no Body field)', () => {
    const payload = inboundPayload({
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME1',
    });
    delete payload.Body;

    const result = normalizeTwilioInboundMessage(payload, ACCOUNT_ID);

    expect(result.body).toBe('');
  });

  it('throws on a payload missing MessageSid', () => {
    const payload = inboundPayload();
    delete payload.MessageSid;

    expect(() => normalizeTwilioInboundMessage(payload, ACCOUNT_ID)).toThrow();
  });

  it('throws on a payload missing From', () => {
    const payload = inboundPayload();
    delete payload.From;

    expect(() => normalizeTwilioInboundMessage(payload, ACCOUNT_ID)).toThrow();
  });

  it('rejects a completely malformed raw payload', () => {
    expect(() => normalizeTwilioInboundMessage('not an object', ACCOUNT_ID)).toThrow();
    expect(() => normalizeTwilioInboundMessage(null, ACCOUNT_ID)).toThrow();
  });

  it('emits a stable externalId across repeated normalize calls for the same payload', () => {
    const payload = inboundPayload();
    const first = normalizeTwilioInboundMessage(payload, ACCOUNT_ID);
    const second = normalizeTwilioInboundMessage(payload, ACCOUNT_ID);

    expect(first.externalId).toBe(second.externalId);
  });
});

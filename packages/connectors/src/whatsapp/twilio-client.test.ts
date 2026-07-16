import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sendTwilioWhatsAppMessage, verifyTwilioSignature } from './twilio-client.js';

const AUTH_TOKEN = 'test-auth-token-abc123';
const URL = 'https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com/whatsapp/inbound';

/** Reference implementation of Twilio's signing algorithm, independent of the code under test —
 * mirrors what twilio.com/docs/usage/webhooks/webhooks-security specifies: HMAC-SHA1(authToken,
 * url + sorted "key+value" concatenation of every form param), base64-encoded. */
function signParams(authToken: string, url: string, formParams: Record<string, string>): string {
  const sortedKeys = Object.keys(formParams).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + formParams[key], url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

describe('verifyTwilioSignature', () => {
  const formParams = {
    MessageSid: 'SM1234567890abcdef1234567890abcdef',
    From: 'whatsapp:+15551234567',
    To: 'whatsapp:+14155238886',
    Body: 'Hello there',
    NumMedia: '0',
  };

  it('accepts a validly signed payload', () => {
    const signature = signParams(AUTH_TOKEN, URL, formParams);

    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      formParams,
      signatureHeader: signature,
    });

    expect(result).toBe(true);
  });

  it('rejects a forged signature', () => {
    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      formParams,
      signatureHeader: 'clearly-not-a-real-signature==',
    });

    expect(result).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      formParams,
      signatureHeader: undefined,
    });

    expect(result).toBe(false);
  });

  it('rejects a signature computed with the wrong auth token', () => {
    const signature = signParams('wrong-token', URL, formParams);

    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      formParams,
      signatureHeader: signature,
    });

    expect(result).toBe(false);
  });

  it('rejects a signature computed against a different URL (tampered/mismatched request)', () => {
    const signature = signParams(AUTH_TOKEN, URL, formParams);

    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: `${URL}/different`,
      formParams,
      signatureHeader: signature,
    });

    expect(result).toBe(false);
  });

  it('rejects when the form params were tampered with after signing', () => {
    const signature = signParams(AUTH_TOKEN, URL, formParams);

    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      formParams: { ...formParams, Body: 'tampered body' },
      signatureHeader: signature,
    });

    expect(result).toBe(false);
  });
});

describe('sendTwilioWhatsAppMessage', () => {
  const credentials = {
    account_sid: 'ACtest1234567890',
    auth_token: AUTH_TOKEN,
    sandbox_number: 'whatsapp:+14155238886',
  };

  it('POSTs to the Twilio Messages API with From=sandbox, To=whatsapp:+<recipient>, and Basic auth', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init: init as RequestInit });
      return new Response(JSON.stringify({ sid: 'SM_sent_1', status: 'queued' }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await sendTwilioWhatsAppMessage({
      credentials,
      to: '+15551234567',
      body: 'On my way',
      fetchImpl,
    });

    expect(result).toEqual({ sid: 'SM_sent_1', status: 'queued' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.account_sid}/Messages.json`,
    );

    const headers = calls[0]?.init.headers as Record<string, string>;
    const expectedAuth = Buffer.from(`${credentials.account_sid}:${credentials.auth_token}`).toString(
      'base64',
    );
    expect(headers.Authorization).toBe(`Basic ${expectedAuth}`);

    const body = new URLSearchParams(calls[0]?.init.body as string);
    expect(body.get('From')).toBe(credentials.sandbox_number);
    expect(body.get('To')).toBe('whatsapp:+15551234567');
    expect(body.get('Body')).toBe('On my way');
  });

  it('accepts a To that already carries the whatsapp: prefix without double-prefixing', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ sid: 'SM_sent_2', status: 'queued' }), { status: 201 });
    }) as unknown as typeof fetch;

    await sendTwilioWhatsAppMessage({
      credentials,
      to: 'whatsapp:+15551234567',
      body: 'hi',
      fetchImpl,
    });

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    const body = new URLSearchParams(calls[0]?.[1].body as string);
    expect(body.get('To')).toBe('whatsapp:+15551234567');
  });

  it('throws with the Twilio error message on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'The From phone number is not verified' }), {
        status: 400,
      });
    }) as unknown as typeof fetch;

    await expect(
      sendTwilioWhatsAppMessage({ credentials, to: '+15551234567', body: 'hi', fetchImpl }),
    ).rejects.toThrow(/not verified/);
  });

  it('throws when the response has no sid even on a 2xx status', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      sendTwilioWhatsAppMessage({ credentials, to: '+15551234567', body: 'hi', fetchImpl }),
    ).rejects.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { decodeFormBody, getSignatureHeader } from './whatsapp-webhook-handler.js';

function eventWithBody(
  body: string,
  opts: { isBase64Encoded?: boolean; headers?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /whatsapp/inbound',
    rawPath: '/whatsapp/inbound',
    rawQueryString: '',
    headers: opts.headers ?? {},
    requestContext: {} as APIGatewayProxyEventV2['requestContext'],
    body,
    isBase64Encoded: opts.isBase64Encoded ?? false,
  } as APIGatewayProxyEventV2;
}

describe('decodeFormBody', () => {
  it('parses a plain (non-base64) form-urlencoded body into a flat string map', () => {
    const event = eventWithBody('MessageSid=SM123&From=whatsapp%3A%2B15551234567&Body=Hello+there');

    const result = decodeFormBody(event);

    expect(result).toEqual({
      MessageSid: 'SM123',
      From: 'whatsapp:+15551234567',
      Body: 'Hello there',
    });
  });

  it('decodes a base64-encoded form-urlencoded body (API Gateway HTTP API default)', () => {
    const raw = 'MessageSid=SM456&From=whatsapp%3A%2B15559876543';
    const event = eventWithBody(Buffer.from(raw).toString('base64'), { isBase64Encoded: true });

    const result = decodeFormBody(event);

    expect(result).toEqual({ MessageSid: 'SM456', From: 'whatsapp:+15559876543' });
  });

  it('returns an empty object for a missing body', () => {
    const event = eventWithBody('');
    event.body = undefined;

    expect(decodeFormBody(event)).toEqual({});
  });
});

describe('getSignatureHeader', () => {
  it('reads the lower-cased x-twilio-signature header', () => {
    const event = eventWithBody('a=b', { headers: { 'x-twilio-signature': 'abc123==' } });

    expect(getSignatureHeader(event)).toBe('abc123==');
  });

  it('returns undefined when the header is absent', () => {
    const event = eventWithBody('a=b', { headers: {} });

    expect(getSignatureHeader(event)).toBeUndefined();
  });
});

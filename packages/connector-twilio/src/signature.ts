import { createHash, timingSafeEqual } from 'node:crypto';

import type { RawWebhookRequest } from '@chief/contracts/connectors';
import twilio from 'twilio';

export type TwilioFormFields = Readonly<
  Record<string, string | readonly string[]>
>;

export interface ParsedTwilioWebhook {
  readonly rawBody: string;
  readonly rawPayloadDigest: string;
  readonly fields: TwilioFormFields;
}

export type TwilioSignatureVerification =
  | {
      readonly verified: true;
      readonly parsed: ParsedTwilioWebhook;
      readonly signature: string;
    }
  | { readonly verified: false; readonly reasonCode: string };

function header(
  headers: Readonly<Record<string, string>>,
  expectedName: string,
): string | undefined {
  const normalized = expectedName.toLowerCase();
  return Object.entries(headers).find(
    ([name]) => name.toLowerCase() === normalized,
  )?.[1];
}

function decodeBase64Strict(value: string): Buffer | undefined {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

function parseFormBody(rawBody: string): TwilioFormFields {
  const parameters = new URLSearchParams(rawBody);
  const mutable: Record<string, string | string[]> = {};
  for (const [name, value] of parameters) {
    if (name.length === 0) {
      throw new Error('TWILIO_FORM_FIELD_NAME_EMPTY');
    }
    const previous = mutable[name];
    if (previous === undefined) {
      mutable[name] = value;
    } else if (typeof previous === 'string') {
      mutable[name] = [previous, value];
    } else {
      previous.push(value);
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(mutable).map(([name, value]) => [
        name,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]),
    ),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function parseTwilioRawWebhook(
  request: RawWebhookRequest,
): ParsedTwilioWebhook {
  if (request.method.toUpperCase() !== 'POST') {
    throw new Error('TWILIO_METHOD_UNSUPPORTED');
  }
  const contentType = header(request.headers, 'content-type');
  if (
    contentType === undefined ||
    !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')
  ) {
    throw new Error('TWILIO_CONTENT_TYPE_UNSUPPORTED');
  }
  const rawBytes = decodeBase64Strict(request.rawBodyBase64);
  if (rawBytes === undefined || rawBytes.length === 0) {
    throw new Error('TWILIO_RAW_BODY_INVALID');
  }
  const rawBody = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  return Object.freeze({
    rawBody,
    rawPayloadDigest: createHash('sha256').update(rawBytes).digest('hex'),
    fields: parseFormBody(rawBody),
  });
}

export function verifyTwilioWebhookSignature(input: {
  readonly request: RawWebhookRequest;
  readonly signingKey: string;
}): TwilioSignatureVerification {
  if (input.signingKey.length === 0) {
    return { verified: false, reasonCode: 'TWILIO_SIGNING_KEY_EMPTY' };
  }
  let parsed: ParsedTwilioWebhook;
  try {
    parsed = parseTwilioRawWebhook(input.request);
  } catch (error) {
    return {
      verified: false,
      reasonCode:
        error instanceof Error ? error.message : 'TWILIO_REQUEST_INVALID',
    };
  }
  const supplied = header(input.request.headers, 'x-twilio-signature');
  if (supplied === undefined || supplied.length === 0) {
    return { verified: false, reasonCode: 'TWILIO_SIGNATURE_MISSING' };
  }
  const expected = twilio.getExpectedTwilioSignature(
    input.signingKey,
    input.request.providerVisibleUrl,
    parsed.fields,
  );
  if (!constantTimeEqual(supplied, expected)) {
    return { verified: false, reasonCode: 'TWILIO_SIGNATURE_INVALID' };
  }
  return { verified: true, parsed, signature: supplied };
}

export function signTwilioFixtureRequest(input: {
  readonly providerVisibleUrl: string;
  readonly rawBody: string;
  readonly signingKey: string;
}): string {
  const fields = parseFormBody(input.rawBody);
  return twilio.getExpectedTwilioSignature(
    input.signingKey,
    input.providerVisibleUrl,
    fields,
  );
}

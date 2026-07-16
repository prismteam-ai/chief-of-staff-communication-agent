import { createHmac, timingSafeEqual } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Twilio WhatsApp sandbox access (brief constraints 2/3, Task 9). One Secrets Manager entry backs
 * every call: `cos/twilio-whatsapp` = `{ account_sid, auth_token, sandbox_number }` — operator-
 * provisioned, verified live (design.md §10: "no secret in code, logs, or the client bundle").
 * Mirrors `gmail-client.ts`'s secret-caching shape, one implementation shared by the ingest-side
 * signature verification and the api-side send path.
 */

export const TWILIO_WHATSAPP_SECRET_ID = 'cos/twilio-whatsapp';

export interface TwilioWhatsAppCredentials {
  account_sid: string;
  auth_token: string;
  sandbox_number: string;
}

let cachedSecretsClient: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  cachedSecretsClient ??= new SecretsManagerClient({});
  return cachedSecretsClient;
}

/** Module-level memo, same `maxAge`-bounded cache shape as `gmail-client.ts`'s `getSecretJson` —
 * the webhook Lambda verifies a signature on every single inbound delivery, so an unbounded
 * per-call Secrets Manager fetch would be wasteful on a warm container. */
const SECRET_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
let cachedCredentials: { value: TwilioWhatsAppCredentials; fetchedAt: number } | undefined;

export async function loadTwilioWhatsAppCredentials(): Promise<TwilioWhatsAppCredentials> {
  if (cachedCredentials && Date.now() - cachedCredentials.fetchedAt < SECRET_CACHE_MAX_AGE_MS) {
    return cachedCredentials.value;
  }
  const result = await secretsClient().send(
    new GetSecretValueCommand({ SecretId: TWILIO_WHATSAPP_SECRET_ID }),
  );
  if (!result.SecretString) {
    throw new Error(`Secret ${TWILIO_WHATSAPP_SECRET_ID} has no SecretString value`);
  }
  const value = JSON.parse(result.SecretString) as TwilioWhatsAppCredentials;
  cachedCredentials = { value, fetchedAt: Date.now() };
  return value;
}

/**
 * Verifies Twilio's `X-Twilio-Signature` header (brief constraint 3: "Verify the Twilio signature
 * ... reject unsigned/forged"). Twilio's algorithm (documented at
 * twilio.com/docs/usage/webhooks/webhooks-security): HMAC-SHA1 of `authToken` over
 * `requestUrl + sorted-and-concatenated "key+value" pairs of every POST form parameter`,
 * base64-encoded, compared against the header value.
 *
 * `url` MUST be the exact URL Twilio signed — the full public HTTPS URL the sandbox is configured
 * to POST to (scheme + host + path + query string exactly as configured in the Twilio console),
 * not any internal/proxied representation API Gateway might expose.
 */
export function verifyTwilioSignature(params: {
  authToken: string;
  url: string;
  formParams: Record<string, string>;
  signatureHeader: string | undefined;
}): boolean {
  const { authToken, url, formParams, signatureHeader } = params;
  if (!signatureHeader) return false;

  const sortedKeys = Object.keys(formParams).sort();
  const data = sortedKeys.reduce(
    (acc, key) => acc + key + formParams[key],
    url,
  );

  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  // Constant-time comparison (forged-signature rejection must not leak timing information); a
  // length mismatch is itself decided in constant time relative to the shorter buffer by bailing
  // out before ever calling timingSafeEqual (which requires equal-length buffers).
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Provider-side confirmation of an outbound send — the shape Twilio's Messages API returns. */
export interface TwilioSendConfirmation {
  sid: string;
  status: string;
}

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/**
 * Sends one WhatsApp message via Twilio's REST API (brief constraint 2): POST
 * `/Accounts/{sid}/Messages.json` with Basic auth (`sid:token`), `From=<sandbox_number>`,
 * `To=whatsapp:+<recipient>`, `Body=<text>`. Returns Twilio's message SID (used for
 * provider-message-id correlation, chatot pattern) and the initial delivery status (`queued`,
 * `failed`, etc.) — final delivery confirmation arrives asynchronously via Twilio's status
 * callback, out of scope for this synchronous call.
 */
export async function sendTwilioWhatsAppMessage(params: {
  credentials: TwilioWhatsAppCredentials;
  to: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<TwilioSendConfirmation> {
  const { credentials, to, body, fetchImpl = fetch } = params;
  const url = `${TWILIO_API_BASE}/Accounts/${credentials.account_sid}/Messages.json`;

  const toAddress = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const form = new URLSearchParams({
    From: credentials.sandbox_number,
    To: toAddress,
    Body: body,
  });

  const basicAuth = Buffer.from(`${credentials.account_sid}:${credentials.auth_token}`).toString(
    'base64',
  );

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: form.toString(),
  });

  const payload = (await response.json()) as { sid?: string; status?: string; message?: string };

  if (!response.ok || !payload.sid) {
    throw new Error(
      `Twilio send failed (HTTP ${response.status}): ${payload.message ?? 'no error message returned'}`,
    );
  }

  return { sid: payload.sid, status: payload.status ?? 'unknown' };
}

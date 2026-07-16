import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Gmail OAuth + API access (brief constraint 4/5). Two Secrets Manager entries back every call:
 *   - `cos/gmail-oauth-client` (operator-provisioned, shared across accounts): `{ client_id,
 *     client_secret }` for the OAuth app registered with redirect URI
 *     `http://localhost:8765/oauth/callback`.
 *   - `cos/gmail-token-<accountId>` (minted by `just gmail-auth`, one per connected mailbox):
 *     `{ refresh_token }`. Access-token refresh happens in-process via `googleapis`' OAuth2
 *     client — no access token is ever persisted, only the long-lived refresh token.
 */

export const GMAIL_OAUTH_CLIENT_SECRET_ID = 'cos/gmail-oauth-client';
export const GMAIL_OAUTH_REDIRECT_URI = 'http://localhost:8765/oauth/callback';

/** Both scopes requested together per brief constraint 5, so Task 6 (send) needs no re-consent. */
export const GMAIL_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

export function gmailTokenSecretId(accountId: string): string {
  return `cos/gmail-token-${accountId}`;
}

export interface GmailOAuthClientCredentials {
  client_id: string;
  client_secret: string;
}

export interface GmailAccountToken {
  refresh_token: string;
}

let cachedSecretsClient: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  cachedSecretsClient ??= new SecretsManagerClient({});
  return cachedSecretsClient;
}

/**
 * Module-level memo for both the OAuth-client secret and every per-account token secret, keyed by
 * secret id. The poller and processor Lambdas call `createGmailClientForAccount` on every
 * invocation (poller: once/minute/account; processor: once/message), so without this cache a busy
 * mailbox re-fetches the same two Secrets Manager values on every single call. `maxAge` bounds
 * staleness — long enough to cut request volume drastically on a warm container, short enough
 * that a rotated/updated secret (e.g. re-running `just gmail-auth`) is picked up within one poller
 * tick without requiring a redeploy or cold start.
 */
const SECRET_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const secretCache = new Map<string, { value: unknown; fetchedAt: number }>();

async function getSecretJson<T>(secretId: string): Promise<T> {
  const cached = secretCache.get(secretId);
  if (cached && Date.now() - cached.fetchedAt < SECRET_CACHE_MAX_AGE_MS) {
    return cached.value as T;
  }

  const result = await secretsClient().send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  const value = JSON.parse(result.SecretString) as T;
  secretCache.set(secretId, { value, fetchedAt: Date.now() });
  return value;
}

export async function loadOAuthClientCredentials(): Promise<GmailOAuthClientCredentials> {
  return getSecretJson<GmailOAuthClientCredentials>(GMAIL_OAUTH_CLIENT_SECRET_ID);
}

export async function loadAccountRefreshToken(accountId: string): Promise<string> {
  const token = await getSecretJson<GmailAccountToken>(gmailTokenSecretId(accountId));
  if (!token.refresh_token) {
    throw new Error(`Secret ${gmailTokenSecretId(accountId)} has no refresh_token`);
  }
  return token.refresh_token;
}

/**
 * Builds an authenticated `gmail_v1.Gmail` API client for one connected account. The OAuth2
 * client refreshes the access token from the refresh token transparently on first API call and
 * on expiry — no manual refresh-token-exchange code needed here.
 */
export async function createGmailClientForAccount(accountId: string): Promise<gmail_v1.Gmail> {
  const [{ client_id, client_secret }, refreshToken] = await Promise.all([
    loadOAuthClientCredentials(),
    loadAccountRefreshToken(accountId),
  ]);

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, GMAIL_OAUTH_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

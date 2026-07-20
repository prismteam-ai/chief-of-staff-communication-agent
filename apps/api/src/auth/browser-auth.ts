import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { z } from 'zod';

import {
  browserSessionTokenHash,
  type BrowserSessionReader,
  type SessionTokenVerifier,
  type VerifiedAuthorityIdentity,
  type VerifiedSessionIdentity,
} from './request-authority.js';

const SESSION_COOKIE = '__Host-chief_session';
const STATE_COOKIE = '__Host-chief_oauth_state';
const OAUTH_VALUE = /^[A-Za-z0-9._~-]+$/u;
const TOKEN_RESPONSE_LIMIT = 32_768;

export interface BrowserOAuthState {
  readonly stateHash: string;
  readonly codeVerifier: string;
  readonly returnPath: string;
  readonly expiresAt: number;
}

export interface BrowserSessionRecord extends VerifiedAuthorityIdentity {
  readonly sessionTokenHash: string;
}

export interface BrowserAuthPersistence extends BrowserSessionReader {
  createOAuthState(state: BrowserOAuthState): Promise<void>;
  consumeOAuthState(
    stateHash: string,
    nowEpochSeconds: number,
  ): Promise<BrowserOAuthState | undefined>;
  createSession(record: BrowserSessionRecord): Promise<void>;
  revokeSession(sessionTokenHash: string): Promise<void>;
}

export interface BrowserAuthHandler {
  handle(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2>;
}

interface BrowserAuthConfiguration {
  readonly clientId: string;
  readonly cognitoDomain: string;
  readonly productOrigin: string;
  readonly callbackUrl: string;
  readonly stateTtlSeconds: number;
  readonly sessionTtlSeconds: number;
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(16_384),
    id_token: z.string().min(1).max(16_384),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().max(3_600),
  })
  .strip();

function hasOnlyQueryKeys(
  event: APIGatewayProxyEventV2,
  allowed: ReadonlySet<string>,
): boolean {
  if (event.rawQueryString.length > 4_096) return false;
  return [...new URLSearchParams(event.rawQueryString).keys()].every((key) =>
    allowed.has(key),
  );
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function boundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(required(environment, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`INVALID_${name}`);
  return value;
}

function strictHttpsOrigin(value: string, error: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin !== value
  )
    throw new Error(error);
  return url;
}

export function browserAuthConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): BrowserAuthConfiguration {
  const clientId = required(environment, 'COGNITO_USER_POOL_CLIENT_ID');
  if (!/^[A-Za-z0-9]{1,128}$/u.test(clientId))
    throw new Error('INVALID_COGNITO_USER_POOL_CLIENT_ID');
  const productOrigin = strictHttpsOrigin(
    required(environment, 'PRODUCT_BASE_URL'),
    'INVALID_PRODUCT_BASE_URL',
  ).origin;
  const domain = strictHttpsOrigin(
    required(environment, 'COGNITO_DOMAIN'),
    'INVALID_COGNITO_DOMAIN',
  );
  if (
    !/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com(?:\.cn)?$/u.test(
      domain.hostname,
    )
  )
    throw new Error('INVALID_COGNITO_DOMAIN');
  return Object.freeze({
    clientId,
    cognitoDomain: domain.origin,
    productOrigin,
    callbackUrl: `${productOrigin}/auth/callback`,
    stateTtlSeconds: boundedInteger(
      environment,
      'AUTH_STATE_TTL_SECONDS',
      120,
      600,
    ),
    sessionTtlSeconds: boundedInteger(
      environment,
      'AUTH_SESSION_TTL_SECONDS',
      300,
      900,
    ),
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function randomOpaque(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function noStoreHeaders(extra: Record<string, string> = {}) {
  return {
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function stateCookie(state: string, maxAge: number): string {
  return `${STATE_COOKIE}=${state}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string, sameSite: 'Lax' | 'Strict'): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`;
}

function singleQueryValue(
  event: APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const values = new URLSearchParams(event.rawQueryString).getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

type CookieRead =
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'value'; value: string }>;

function readCookie(event: APIGatewayProxyEventV2, name: string): CookieRead {
  const headersFound = Object.entries(event.headers).filter(
    ([headerName]) => headerName.toLocaleLowerCase('en-US') === 'cookie',
  );
  const gatewayCookies = event.cookies ?? [];
  if (
    headersFound.length > 1 ||
    (headersFound[0]?.[1]?.length ?? 0) > 4_096 ||
    gatewayCookies.length > 64 ||
    gatewayCookies.reduce((length, value) => length + value.length, 0) >
      4_096 ||
    (headersFound.length === 1 && gatewayCookies.length > 0)
  )
    return Object.freeze({ kind: 'invalid' });
  const parts =
    headersFound.length === 1
      ? (headersFound[0]?.[1] ?? '').split(';')
      : gatewayCookies.flatMap((value) => value.split(';'));
  const matches = parts
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (matches.length === 0) return Object.freeze({ kind: 'missing' });
  if (matches.length > 1) return Object.freeze({ kind: 'invalid' });
  return Object.freeze({ kind: 'value', value: matches[0] as string });
}

function cookieValue(
  event: APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const result = readCookie(event, name);
  return result.kind === 'value' ? result.value : undefined;
}

function sameValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function isSafeBrowserReturnPath(candidate: string): boolean {
  return (
    candidate.length <= 512 &&
    candidate.startsWith('/') &&
    !candidate.startsWith('//') &&
    !candidate.includes('\\') &&
    !candidate.includes('?') &&
    !candidate.includes('#') &&
    ![...candidate].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  );
}

function returnPath(event: APIGatewayProxyEventV2): string {
  const candidate = singleQueryValue(event, 'returnTo') ?? '/';
  return isSafeBrowserReturnPath(candidate) ? candidate : '/';
}

function badRequest(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 400,
    headers: noStoreHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ error: 'invalid_auth_request' }),
  };
}

function retryLogin(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 302,
    headers: noStoreHeaders({ location: '/auth/login' }),
    cookies: [clearCookie(STATE_COOKIE, 'Lax')],
  };
}

function methodNotAllowed(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 405,
    headers: noStoreHeaders({ allow: 'GET, POST' }),
  };
}

async function exchangeAuthorizationCode(input: {
  readonly fetch: typeof fetch;
  readonly configuration: BrowserAuthConfiguration;
  readonly code: string;
  readonly codeVerifier: string;
}): Promise<z.infer<typeof tokenResponseSchema>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.configuration.clientId,
    code: input.code,
    redirect_uri: input.configuration.callbackUrl,
    code_verifier: input.codeVerifier,
  });
  const response = await input.fetch(
    `${input.configuration.cognitoDomain}/oauth2/token`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(5_000),
    },
  );
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (!response.ok || declaredLength > TOKEN_RESPONSE_LIMIT)
    throw new Error('COGNITO_TOKEN_EXCHANGE_FAILED');
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, 'utf8') > TOKEN_RESPONSE_LIMIT)
    throw new Error('COGNITO_TOKEN_EXCHANGE_FAILED');
  try {
    return tokenResponseSchema.parse(JSON.parse(responseText));
  } catch {
    throw new Error('COGNITO_TOKEN_EXCHANGE_FAILED');
  }
}

export function createBrowserAuthHandler(input: {
  readonly configuration: BrowserAuthConfiguration;
  readonly persistence: BrowserAuthPersistence;
  readonly accessTokenVerifier: SessionTokenVerifier;
  readonly idTokenVerifier: SessionTokenVerifier;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}): BrowserAuthHandler {
  const now = input.now ?? (() => new Date());
  const fetchImplementation = input.fetch ?? fetch;

  return {
    async handle(event) {
      const path = event.rawPath;
      const method = event.requestContext.http.method.toUpperCase();
      if (path === '/auth/login') {
        if (method !== 'GET') return methodNotAllowed();
        if (!hasOnlyQueryKeys(event, new Set(['returnTo'])))
          return badRequest();
        const state = randomOpaque(32);
        const codeVerifier = randomOpaque(64);
        const expiresAt =
          Math.floor(now().getTime() / 1_000) +
          input.configuration.stateTtlSeconds;
        await input.persistence.createOAuthState({
          stateHash: sha256(state),
          codeVerifier,
          returnPath: returnPath(event),
          expiresAt,
        });
        const authorizeUrl = new URL(
          '/oauth2/authorize',
          input.configuration.cognitoDomain,
        );
        authorizeUrl.search = new URLSearchParams({
          response_type: 'code',
          client_id: input.configuration.clientId,
          redirect_uri: input.configuration.callbackUrl,
          scope: 'openid email',
          state,
          code_challenge: pkceChallenge(codeVerifier),
          code_challenge_method: 'S256',
        }).toString();
        return {
          statusCode: 302,
          headers: noStoreHeaders({ location: authorizeUrl.toString() }),
          cookies: [stateCookie(state, input.configuration.stateTtlSeconds)],
        };
      }

      if (path === '/auth/callback') {
        if (method !== 'GET') return methodNotAllowed();
        if (!hasOnlyQueryKeys(event, new Set(['code', 'state'])))
          return badRequest();
        const code = singleQueryValue(event, 'code');
        const state = singleQueryValue(event, 'state');
        const stateCookieRead = readCookie(event, STATE_COOKIE);
        if (
          code === undefined ||
          state === undefined ||
          code.length > 2_048 ||
          state.length !== 43 ||
          !OAUTH_VALUE.test(code) ||
          !OAUTH_VALUE.test(state)
        )
          return badRequest();
        if (stateCookieRead.kind === 'invalid') return badRequest();
        if (stateCookieRead.kind === 'missing') return retryLogin();
        if (!sameValue(state, stateCookieRead.value)) return badRequest();
        const nowEpochSeconds = Math.floor(now().getTime() / 1_000);
        const pending = await input.persistence.consumeOAuthState(
          sha256(state),
          nowEpochSeconds,
        );
        if (pending === undefined) return retryLogin();
        let accessIdentity: VerifiedSessionIdentity;
        let idIdentity: VerifiedSessionIdentity;
        try {
          const tokens = await exchangeAuthorizationCode({
            fetch: fetchImplementation,
            configuration: input.configuration,
            code,
            codeVerifier: pending.codeVerifier,
          });
          [accessIdentity, idIdentity] = await Promise.all([
            input.accessTokenVerifier.verify(tokens.access_token),
            input.idTokenVerifier.verify(tokens.id_token),
          ]);
        } catch {
          return badRequest();
        }
        if (
          accessIdentity.tokenUse !== 'access' ||
          idIdentity.tokenUse !== 'id' ||
          accessIdentity.subject !== idIdentity.subject ||
          accessIdentity.clientId !== input.configuration.clientId ||
          idIdentity.clientId !== input.configuration.clientId ||
          accessIdentity.clientId !== idIdentity.clientId ||
          accessIdentity.issuer !== idIdentity.issuer
        )
          return badRequest();
        const expiresAt = Math.min(
          accessIdentity.expiresAt,
          idIdentity.expiresAt,
          nowEpochSeconds + input.configuration.sessionTtlSeconds,
        );
        if (expiresAt <= nowEpochSeconds) return badRequest();
        const sessionToken = randomOpaque(32);
        await input.persistence.createSession({
          sessionTokenHash: browserSessionTokenHash(sessionToken),
          subject: accessIdentity.subject,
          clientId: accessIdentity.clientId,
          issuer: accessIdentity.issuer,
          expiresAt,
        });
        return {
          statusCode: 303,
          headers: noStoreHeaders({ location: pending.returnPath }),
          cookies: [
            sessionCookie(sessionToken, expiresAt - nowEpochSeconds),
            clearCookie(STATE_COOKIE, 'Lax'),
          ],
        };
      }

      if (path === '/auth/logout' || path === '/auth/revoke') {
        if (method !== 'POST') return methodNotAllowed();
        const origin = Object.entries(event.headers).filter(
          ([name]) => name.toLocaleLowerCase('en-US') === 'origin',
        );
        if (
          origin.length !== 1 ||
          origin[0]?.[1] !== input.configuration.productOrigin
        )
          return { statusCode: 403, headers: noStoreHeaders() };
        const session = cookieValue(event, SESSION_COOKIE);
        if (session !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(session))
          await input.persistence.revokeSession(
            browserSessionTokenHash(session),
          );
        return {
          statusCode: 204,
          headers: noStoreHeaders(),
          cookies: [clearCookie(SESSION_COOKIE, 'Strict')],
        };
      }

      return { statusCode: 404, headers: noStoreHeaders() };
    },
  };
}

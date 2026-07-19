import { createHash } from 'node:crypto';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import {
  browserAuthConfiguration,
  createBrowserAuthHandler,
  type BrowserAuthPersistence,
  type BrowserOAuthState,
  type BrowserSessionRecord,
} from './browser-auth.js';
import type {
  SessionTokenVerifier,
  VerifiedSessionIdentity,
} from './request-authority.js';

const nowEpoch = 1_768_737_600;
const now = () => new Date(nowEpoch * 1_000);
const stateCookieForTest = '__Host-chief_oauth_state';
const sessionCookieForTest = '__Host-chief_session';
const configuration = browserAuthConfiguration({
  AUTH_SESSION_TTL_SECONDS: '900',
  AUTH_STATE_TTL_SECONDS: '300',
  COGNITO_DOMAIN:
    'https://chief-417242953053-us-east-2.auth.us-east-2.amazoncognito.com',
  COGNITO_USER_POOL_CLIENT_ID: 'chiefclientid123',
  PRODUCT_BASE_URL: 'https://chief.example.test',
});

function event(
  path: string,
  options: {
    readonly method?: string;
    readonly query?: string;
    readonly headers?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 {
  const method = options.method ?? 'GET';
  return {
    version: '2.0',
    routeKey: 'ANY /auth/{proxy+}',
    rawPath: path,
    rawQueryString: options.query ?? '',
    headers: options.headers ?? {},
    requestContext: {
      accountId: '417242953053',
      apiId: 'fixture-api',
      domainName: 'chief.example.test',
      domainPrefix: 'chief',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'fixture-request',
      routeKey: 'ANY /auth/{proxy+}',
      stage: '$default',
      time: '19/Jul/2026:12:00:00 +0000',
      timeEpoch: nowEpoch * 1_000,
    },
    isBase64Encoded: false,
  };
}

function memoryPersistence() {
  const states = new Map<string, BrowserOAuthState>();
  const sessions = new Map<string, BrowserSessionRecord>();
  const persistence: BrowserAuthPersistence = {
    createOAuthState: (state) => {
      states.set(state.stateHash, state);
      return Promise.resolve();
    },
    consumeOAuthState: (stateHash, currentEpoch) => {
      const state = states.get(stateHash);
      states.delete(stateHash);
      return Promise.resolve(
        state !== undefined && state.expiresAt > currentEpoch
          ? state
          : undefined,
      );
    },
    createSession: (session) => {
      sessions.set(session.sessionTokenHash, session);
      return Promise.resolve();
    },
    readSession: (hash) => Promise.resolve(sessions.get(hash)),
    revokeSession: (hash) => {
      sessions.delete(hash);
      return Promise.resolve();
    },
  };
  return { persistence, sessions, states };
}

function identity(
  tokenUse: 'access' | 'id',
  overrides: Partial<VerifiedSessionIdentity> = {},
): VerifiedSessionIdentity {
  return {
    subject: 'cognito-subject',
    issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123',
    clientId: configuration.clientId,
    tokenUse,
    issuedAt: nowEpoch - 10,
    expiresAt: nowEpoch + 900,
    tokenId: `${tokenUse}-jti`,
    ...overrides,
  };
}

function verifier(
  tokenUse: 'access' | 'id',
  overrides: Partial<VerifiedSessionIdentity> = {},
): SessionTokenVerifier {
  return { verify: () => Promise.resolve(identity(tokenUse, overrides)) };
}

function tokenExchange() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: ['synthetic', 'access', 'value'].join('.'),
          id_token: ['synthetic', 'identity', 'value'].join('.'),
          token_type: 'Bearer',
          expires_in: 900,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    ),
  );
}

async function beginLogin(
  handler: ReturnType<typeof createBrowserAuthHandler>,
  returnTo = '/inbox/thread-q3-launch',
) {
  const response = await handler.handle(
    event('/auth/login', {
      query: `returnTo=${encodeURIComponent(returnTo)}`,
    }),
  );
  const location = new URL(String(response.headers?.location));
  const state = location.searchParams.get('state') as string;
  return { response, location, state };
}

describe('Hosted UI browser authorization flow', () => {
  it('creates bounded state and S256 PKCE without exposing a verifier or tokens', async () => {
    const memory = memoryPersistence();
    const handler = createBrowserAuthHandler({
      configuration,
      persistence: memory.persistence,
      accessTokenVerifier: verifier('access'),
      idTokenVerifier: verifier('id'),
      fetch: tokenExchange(),
      now,
    });

    const { response, location, state } = await beginLogin(handler);

    expect(response.statusCode).toBe(302);
    expect(location.origin).toBe(configuration.cognitoDomain);
    expect(location.pathname).toBe('/oauth2/authorize');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toHaveLength(43);
    expect(state).toHaveLength(43);
    expect(response.cookies?.[0]).toContain('HttpOnly; Secure; SameSite=Lax');
    const persisted = memory.states.get(
      createHash('sha256').update(state).digest('hex'),
    );
    expect(persisted?.codeVerifier).toHaveLength(86);
    expect(persisted?.expiresAt).toBe(nowEpoch + 300);
    expect(location.toString()).not.toContain(
      persisted?.codeVerifier as string,
    );
    expect(location.searchParams.has('access_token')).toBe(false);
    expect(location.searchParams.has('id_token')).toBe(false);
  });

  it('exchanges a single-use callback and persists only a session hash plus verified identity', async () => {
    const memory = memoryPersistence();
    const exchange = tokenExchange();
    const handler = createBrowserAuthHandler({
      configuration,
      persistence: memory.persistence,
      accessTokenVerifier: verifier('access'),
      idTokenVerifier: verifier('id'),
      fetch: exchange,
      now,
    });
    const { response: login, state } = await beginLogin(handler);
    const stateCookie = login.cookies?.[0] as string;
    const callback = event('/auth/callback', {
      query: `code=synthetic-code&state=${state}`,
      headers: { cookie: stateCookie.split(';')[0] as string },
    });

    const response = await handler.handle(callback);

    expect(response.statusCode).toBe(303);
    expect(response.headers?.location).toBe('/inbox/thread-q3-launch');
    expect(response.cookies?.[0]).toContain(
      'HttpOnly; Secure; SameSite=Strict',
    );
    expect(response.cookies?.[1]).toContain('Max-Age=0');
    expect(memory.sessions.size).toBe(1);
    const [sessionHash, stored] = [...memory.sessions.entries()][0] as [
      string,
      BrowserSessionRecord,
    ];
    const clearSession = /__Host-chief_session=([^;]+)/u.exec(
      response.cookies?.[0] as string,
    )?.[1] as string;
    expect(clearSession).toHaveLength(43);
    expect(sessionHash).toBe(
      createHash('sha256').update(clearSession).digest('hex'),
    );
    expect(stored).toEqual({
      sessionTokenHash: sessionHash,
      subject: 'cognito-subject',
      clientId: configuration.clientId,
      issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123',
      expiresAt: nowEpoch + 900,
    });
    expect(JSON.stringify(stored)).not.toContain(clearSession);
    expect(JSON.stringify(stored)).not.toContain('synthetic.access.value');

    const replay = await handler.handle(callback);
    expect(replay.statusCode).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('rejects state mismatch and expired state before token exchange', async () => {
    const memory = memoryPersistence();
    const exchange = tokenExchange();
    let currentEpoch = nowEpoch;
    const handler = createBrowserAuthHandler({
      configuration,
      persistence: memory.persistence,
      accessTokenVerifier: verifier('access'),
      idTokenVerifier: verifier('id'),
      fetch: exchange,
      now: () => new Date(currentEpoch * 1_000),
    });
    const { response: login, state } = await beginLogin(handler);

    const mismatch = await handler.handle(
      event('/auth/callback', {
        query: `code=synthetic-code&state=${state}`,
        headers: {
          cookie: `${stateCookieForTest}=${Buffer.alloc(32, 4).toString('base64url')}`,
        },
      }),
    );
    expect(mismatch.statusCode).toBe(400);
    currentEpoch += 301;
    const expired = await handler.handle(
      event('/auth/callback', {
        query: `code=synthetic-code&state=${state}`,
        headers: { cookie: login.cookies?.[0]?.split(';')[0] as string },
      }),
    );
    expect(expired.statusCode).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('rejects unexpected callback fields so credentials cannot ride in the URL', async () => {
    const memory = memoryPersistence();
    const exchange = tokenExchange();
    const handler = createBrowserAuthHandler({
      configuration,
      persistence: memory.persistence,
      accessTokenVerifier: verifier('access'),
      idTokenVerifier: verifier('id'),
      fetch: exchange,
      now,
    });
    const { response: login, state } = await beginLogin(handler);

    const response = await handler.handle(
      event('/auth/callback', {
        query: `code=synthetic-code&state=${state}&access_token=forbidden`,
        headers: { cookie: login.cookies?.[0]?.split(';')[0] as string },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    [
      'wrong client',
      verifier('access', { clientId: 'attacker-client' }),
      verifier('id'),
    ],
    [
      'wrong issuer',
      verifier('access'),
      verifier('id', { issuer: 'https://issuer.attacker.example' }),
    ],
  ])('rejects verified tokens with %s binding', async (_label, access, id) => {
    const memory = memoryPersistence();
    const handler = createBrowserAuthHandler({
      configuration,
      persistence: memory.persistence,
      accessTokenVerifier: access,
      idTokenVerifier: id,
      fetch: tokenExchange(),
      now,
    });
    const { response: login, state } = await beginLogin(handler);

    const response = await handler.handle(
      event('/auth/callback', {
        query: `code=synthetic-code&state=${state}`,
        headers: { cookie: login.cookies?.[0]?.split(';')[0] as string },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(memory.sessions.size).toBe(0);
    expect(JSON.stringify(response)).not.toContain('synthetic.access.value');
  });

  it('requires same-origin POST for logout and revoke, then clears server and browser state', async () => {
    const memory = memoryPersistence();
    const sessionToken = Buffer.alloc(32, 9).toString('base64url');
    const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
    memory.sessions.set(sessionHash, {
      sessionTokenHash: sessionHash,
      subject: 'cognito-subject',
      clientId: configuration.clientId,
      issuer: 'https://cognito-idp.us-east-2.amazonaws.com/pool',
      expiresAt: nowEpoch + 900,
    });
    const revoke = vi.spyOn(memory.persistence, 'revokeSession');
    const handler = createBrowserAuthHandler({
      configuration,
      persistence: memory.persistence,
      accessTokenVerifier: verifier('access'),
      idTokenVerifier: verifier('id'),
      fetch: tokenExchange(),
      now,
    });
    const cookie = `${sessionCookieForTest}=${sessionToken}`;

    const csrf = await handler.handle(
      event('/auth/logout', { method: 'POST', headers: { cookie } }),
    );
    expect(csrf.statusCode).toBe(403);
    expect(revoke).not.toHaveBeenCalled();

    for (const path of ['/auth/logout', '/auth/revoke']) {
      memory.sessions.set(sessionHash, {
        sessionTokenHash: sessionHash,
        subject: 'cognito-subject',
        clientId: configuration.clientId,
        issuer: 'https://cognito-idp.us-east-2.amazonaws.com/pool',
        expiresAt: nowEpoch + 900,
      });
      const response = await handler.handle(
        event(path, {
          method: 'POST',
          headers: { cookie, origin: configuration.productOrigin },
        }),
      );
      expect(response.statusCode).toBe(204);
      expect(response.cookies?.[0]).toContain(
        'Max-Age=0; HttpOnly; Secure; SameSite=Strict',
      );
      expect(memory.sessions.has(sessionHash)).toBe(false);
    }
  });
});

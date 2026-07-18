import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGmailAuthorizationUrl,
  createGmailOAuthBootstrapProof,
  exchangeGmailAuthorizationCode,
  GMAIL_OAUTH_BOOTSTRAP_MAX_TOKEN_RESPONSE_BYTES,
  GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI,
  GMAIL_OAUTH_BOOTSTRAP_SCOPE,
  GmailOAuthBootstrapError,
  GmailOAuthCallbackGate,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  parseGmailOAuthClientJson,
  persistGmailRefreshToken,
  startGmailOAuthCallbackServer,
  type GmailOAuthBootstrapClient,
  type GmailOAuthBootstrapFileOperations,
} from './oauth-bootstrap.js';

const CLIENT_ID = 'bootstrap-client.apps.example.invalid';
const CLIENT_SECRET = ['fixture', 'client', 'secret', 'not', 'real'].join('-');
const REFRESH_TOKEN = 'fixture-refresh-token-not-real';
const CODE = 'fixture-authorization-code';

function clientJson(applicationType: 'installed' | 'web' = 'web'): string {
  return JSON.stringify({
    [applicationType]: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: [GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI],
    },
  });
}

const client: GmailOAuthBootstrapClient =
  parseGmailOAuthClientJson(clientJson());
const verifier = 'v'.repeat(43);

function deterministicFileOperations(
  events: string[] = [],
): GmailOAuthBootstrapFileOperations {
  return {
    open: (path) => open(path, 'wx', 0o600),
    write: async (handle, value) => {
      events.push('write');
      await handle.writeFile(value, { encoding: 'utf8' });
    },
    sync: async (handle) => {
      events.push('sync');
      await handle.sync();
    },
    close: async (handle) => {
      events.push('close');
      await handle.close();
    },
    stat: (handle) => handle.stat(),
    link: async (existingPath, newPath) => {
      events.push('link');
      await link(existingPath, newPath);
    },
    rename: async (oldPath, newPath) => {
      events.push('rename');
      await rename(oldPath, newPath);
    },
    unlink,
    lstat,
    restrict: async (path) => {
      events.push('restrict');
      await chmod(path, 0o600);
    },
  };
}

function cleanupFailureFileOperations(
  stage: 'partial-write' | 'sync' | 'close',
  events: string[],
  unlinkSucceeds = true,
): GmailOAuthBootstrapFileOperations {
  const operations = deterministicFileOperations(events);
  return {
    ...operations,
    write: async (handle, value) => {
      events.push('write');
      if (stage === 'partial-write') {
        await handle.writeFile(value.slice(0, 7), { encoding: 'utf8' });
        throw new Error('private partial-write detail');
      }
      await handle.writeFile(value, { encoding: 'utf8' });
    },
    sync: async (handle) => {
      events.push('sync');
      if (stage === 'sync') throw new Error('private sync detail');
      await handle.sync();
    },
    close: async (handle) => {
      events.push('close');
      try {
        await handle.close();
      } catch {
        // The injected close failure below remains deterministic if already closed.
      }
      throw new Error(
        stage === 'close'
          ? 'private primary-close detail'
          : 'private cleanup-close detail',
      );
    },
    unlink: async (path) => {
      events.push('unlink');
      if (!unlinkSucceeds) throw new Error('private cleanup-unlink detail');
      await unlink(path);
    },
  };
}

function tokenResponse(
  body: unknown = {
    refresh_token: REFRESH_TOKEN,
    token_type: 'Bearer',
    scope: GMAIL_OAUTH_BOOTSTRAP_SCOPE,
  },
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}

describe('Gmail OAuth bootstrap client and proof', () => {
  it.each(['installed', 'web'] as const)(
    'parses an exact %s client without widening redirect authority',
    (applicationType) => {
      expect(parseGmailOAuthClientJson(clientJson(applicationType))).toEqual({
        applicationType,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI,
      });
    },
  );

  it.each([
    'https://example.invalid/api/oauth/google/callback',
    'http://0.0.0.0:3000/api/oauth/google/callback',
    'http://localhost:3001/api/oauth/google/callback',
    'http://localhost:3000/another-path',
  ])('rejects unsafe or mismatched redirect %s', (redirectUri) => {
    expect(() =>
      parseGmailOAuthClientJson(
        JSON.stringify({
          web: {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uris: [redirectUri],
          },
        }),
      ),
    ).toThrow('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  });

  it('generates independent random state and RFC 7636 S256 proof', () => {
    const first = createGmailOAuthBootstrapProof();
    const second = createGmailOAuthBootstrapProof();
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.state).not.toBe(second.state);
    expect(first.pkceVerifier).not.toBe(second.pkceVerifier);
    expect(first.pkceChallenge).toBe(
      createHash('sha256')
        .update(first.pkceVerifier, 'ascii')
        .digest('base64url'),
    );
  });

  it('builds the fixed, exact read-only offline consent request', () => {
    const proof = createGmailOAuthBootstrapProof();
    const url = new URL(
      buildGmailAuthorizationUrl({
        clientId: CLIENT_ID,
        state: proof.state,
        pkceChallenge: proof.pkceChallenge,
        loginHint: 'expected@example.invalid',
      }),
    );
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: 'offline',
      code_challenge_method: 'S256',
      include_granted_scopes: 'false',
      prompt: 'consent',
      redirect_uri: GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI,
      response_type: 'code',
      scope: GMAIL_OAUTH_BOOTSTRAP_SCOPE,
      state: proof.state,
    });
    expect(url.searchParams.get('login_hint')).toBe('expected@example.invalid');
    expect(url.search).not.toContain('gmail.send');
    expect(url.search).not.toContain('openid');
    expect(url.search).not.toContain('profile');
  });
});

describe('Gmail OAuth callback gate and bounded loopback server', () => {
  const state = 's'.repeat(43);
  const validRequest = {
    method: 'GET',
    target: `/api/oauth/google/callback?code=${CODE}&state=${state}`,
    hostHeaders: ['localhost:3000'],
  } as const;

  it.each([
    { ...validRequest, method: 'POST' },
    { ...validRequest, target: `/wrong?code=${CODE}&state=${state}` },
    {
      ...validRequest,
      target: `/api/oauth/x/../google/callback?code=${CODE}&state=${state}`,
    },
    {
      ...validRequest,
      target: `http://localhost:3000/api/oauth/google/callback?code=${CODE}&state=${state}`,
    },
    { ...validRequest, hostHeaders: ['127.0.0.1:3000'] },
    { ...validRequest, hostHeaders: ['localhost:3000', 'localhost:3000'] },
    { ...validRequest, contentLength: '1' },
    { ...validRequest, transferEncoding: 'chunked' },
    {
      ...validRequest,
      target: `/api/oauth/google/callback?code=%ZZ&state=${state}`,
    },
    {
      ...validRequest,
      target: `/api/oauth/google/callback?code=%FF&state=${state}`,
    },
    {
      ...validRequest,
      target: `/api/oauth/google/callback?code=${CODE}&state=wrong`,
    },
    {
      ...validRequest,
      target: `/api/oauth/google/callback?code=${'x'.repeat(4_097)}&state=${state}`,
    },
    {
      ...validRequest,
      target: `/api/oauth/google/callback?padding=${'x'.repeat(8_200)}`,
    },
  ])('rejects malformed callback request %#', (candidate) => {
    expect(new GmailOAuthCallbackGate(state).evaluate(candidate)).toMatchObject(
      {
        kind: 'invalid',
      },
    );
  });

  it('accepts one callback, rejects replay, and normalizes OAuth errors', () => {
    const gate = new GmailOAuthCallbackGate(state);
    expect(gate.evaluate(validRequest)).toEqual({ kind: 'code', code: CODE });
    expect(gate.evaluate(validRequest)).toEqual({
      kind: 'invalid',
      code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_REPLAY',
    });
    expect(
      new GmailOAuthCallbackGate(state).evaluate({
        ...validRequest,
        target: `/api/oauth/google/callback?error=access_denied&error_description=sensitive&state=${state}`,
      }),
    ).toEqual({
      kind: 'oauth_error',
      code: 'GMAIL_OAUTH_BOOTSTRAP_PROVIDER_ERROR',
    });
  });

  it('binds the fixed IPv4 loopback and returns content-free success HTML', async () => {
    const server = await startGmailOAuthCallbackServer({
      expectedState: state,
      deadlineMilliseconds: 2_000,
    });
    try {
      const responseBody = await new Promise<string>(
        (resolvePromise, rejectPromise) => {
          const outbound = request(
            {
              hostname: '127.0.0.1',
              port: 3000,
              method: 'GET',
              path: `/api/oauth/google/callback?code=${CODE}&state=${state}`,
              headers: { Host: 'localhost:3000' },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () =>
                resolvePromise(Buffer.concat(chunks).toString('utf8')),
              );
            },
          );
          outbound.once('error', rejectPromise);
          outbound.end();
        },
      );
      await expect(server.callback).resolves.toBe(CODE);
      expect(responseBody).toContain('authorization received');
      expect(responseBody).not.toContain(CODE);
      expect(responseBody).not.toContain(state);
    } finally {
      await server.close();
    }
  });

  it('enforces the overall callback deadline', async () => {
    const server = await startGmailOAuthCallbackServer({
      expectedState: state,
      deadlineMilliseconds: 20,
    });
    try {
      await expect(server.callback).rejects.toThrow(
        'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_TIMEOUT',
      );
    } finally {
      await server.close();
    }
  });

  it('destroys a partial raw loopback connection at the overall deadline', async () => {
    const startedAt = performance.now();
    let tokenExchangeCalls = 0;
    let tokenWriteCalls = 0;
    const server = await startGmailOAuthCallbackServer({
      expectedState: state,
      deadlineMilliseconds: 40,
    });
    const downstream = server.callback.then(() => {
      tokenExchangeCalls += 1;
      tokenWriteCalls += 1;
    });
    const socket = connect({ host: '127.0.0.1', port: 3000 });
    const socketClosed = new Promise<void>((resolvePromise) => {
      socket.once('close', () => resolvePromise());
    });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.once('connect', () => {
          socket.write(
            `GET /api/oauth/google/callback?code=${CODE}&state=${state} HTTP/1.1\r\nHost: local`,
          );
          resolvePromise();
        });
        socket.once('error', rejectPromise);
      });
      await expect(downstream).rejects.toThrow(
        'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_TIMEOUT',
      );
      await server.close();
      await socketClosed;
      expect(socket.destroyed).toBe(true);
      expect(tokenExchangeCalls).toBe(0);
      expect(tokenWriteCalls).toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(750);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('explicit close rejects and destroys a partial raw loopback connection', async () => {
    const startedAt = performance.now();
    const server = await startGmailOAuthCallbackServer({
      expectedState: state,
      deadlineMilliseconds: 2_000,
    });
    const socket = connect({ host: '127.0.0.1', port: 3000 });
    const socketClosed = new Promise<void>((resolvePromise) => {
      socket.once('close', () => resolvePromise());
    });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.once('connect', () => {
          socket.write('GET /api/oauth/google/callback HTTP/1.1\r\n');
          resolvePromise();
        });
        socket.once('error', rejectPromise);
      });
      const callbackRejection = expect(server.callback).rejects.toThrow(
        'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      );
      await server.close();
      await callbackRejection;
      await socketClosed;
      expect(socket.destroyed).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(750);
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});

describe('fixed Google token exchange', () => {
  it('uses one fixed, manual, bounded request and returns only validated fields', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const result = await exchangeGmailAuthorizationCode({
      client,
      code: CODE,
      pkceVerifier: verifier,
      fetch: (url, init) => {
        capturedUrl =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.toString()
              : url.url;
        capturedInit = init;
        return Promise.resolve(tokenResponse());
      },
    });
    expect(capturedUrl).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(capturedInit).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
    expect(result).toEqual({
      refreshToken: REFRESH_TOKEN,
      scopes: [GMAIL_OAUTH_BOOTSTRAP_SCOPE],
      tokenType: 'Bearer',
    });
  });

  it.each([
    [
      'redirect',
      () =>
        tokenResponse(
          {},
          { status: 302, headers: { location: 'https://example.invalid' } },
        ),
      'GMAIL_OAUTH_BOOTSTRAP_TOKEN_REDIRECT_FORBIDDEN',
    ],
    [
      'content type',
      () => tokenResponse({}, { headers: { 'content-type': 'text/html' } }),
      'GMAIL_OAUTH_BOOTSTRAP_TOKEN_CONTENT_TYPE_INVALID',
    ],
    [
      'status',
      () => tokenResponse({}, { status: 400 }),
      'GMAIL_OAUTH_BOOTSTRAP_TOKEN_STATUS_INVALID',
    ],
    [
      'missing refresh token',
      () =>
        tokenResponse({
          token_type: 'Bearer',
          scope: GMAIL_OAUTH_BOOTSTRAP_SCOPE,
        }),
      'GMAIL_OAUTH_BOOTSTRAP_TOKEN_MISSING_REFRESH_TOKEN',
    ],
    [
      'scope widening',
      () =>
        tokenResponse({
          refresh_token: REFRESH_TOKEN,
          token_type: 'Bearer',
          scope: `${GMAIL_OAUTH_BOOTSTRAP_SCOPE} openid`,
        }),
      'GMAIL_OAUTH_BOOTSTRAP_SCOPE_INVALID',
    ],
    [
      'missing scope',
      () =>
        tokenResponse({
          refresh_token: REFRESH_TOKEN,
          token_type: 'Bearer',
          scope: '',
        }),
      'GMAIL_OAUTH_BOOTSTRAP_SCOPE_INVALID',
    ],
    [
      'token type',
      () =>
        tokenResponse({
          refresh_token: REFRESH_TOKEN,
          token_type: 'MAC',
          scope: GMAIL_OAUTH_BOOTSTRAP_SCOPE,
        }),
      'GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID',
    ],
  ] as const)('rejects token endpoint %s', async (_name, response, code) => {
    await expect(
      exchangeGmailAuthorizationCode({
        client,
        code: CODE,
        pkceVerifier: verifier,
        fetch: () => Promise.resolve(response()),
      }),
    ).rejects.toThrow(code);
  });

  it('rejects streamed and declared oversized responses', async () => {
    const oversized = 'x'.repeat(
      GMAIL_OAUTH_BOOTSTRAP_MAX_TOKEN_RESPONSE_BYTES + 1,
    );
    for (const response of [
      new Response(oversized, {
        headers: { 'content-type': 'application/json' },
      }),
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': String(
            GMAIL_OAUTH_BOOTSTRAP_MAX_TOKEN_RESPONSE_BYTES + 1,
          ),
        },
      }),
    ]) {
      await expect(
        exchangeGmailAuthorizationCode({
          client,
          code: CODE,
          pkceVerifier: verifier,
          fetch: () => Promise.resolve(response),
        }),
      ).rejects.toThrow('GMAIL_OAUTH_BOOTSTRAP_TOKEN_RESPONSE_TOO_LARGE');
    }
  });

  it('redacts endpoint payloads and credentials from every error', async () => {
    const sensitive = `${CLIENT_SECRET}:${REFRESH_TOKEN}:${CODE}`;
    let caught: unknown;
    try {
      await exchangeGmailAuthorizationCode({
        client,
        code: CODE,
        pkceVerifier: verifier,
        fetch: () =>
          Promise.resolve(tokenResponse({ error: sensitive }, { status: 400 })),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GmailOAuthBootstrapError);
    expect(JSON.stringify(caught)).not.toContain(sensitive);
    expect(String(caught)).not.toContain(CLIENT_SECRET);
    expect(String(caught)).not.toContain(REFRESH_TOKEN);
    expect(String(caught)).not.toContain(CODE);
  });

  it('applies the fixed timeout through response-body consumption', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                refresh_token: REFRESH_TOKEN,
                token_type: 'Bearer',
                scope: GMAIL_OAUTH_BOOTSTRAP_SCOPE,
              }),
            ),
          );
          controller.close();
        }, 50);
      },
    });
    await expect(
      exchangeGmailAuthorizationCode({
        client,
        code: CODE,
        pkceVerifier: verifier,
        timeoutMilliseconds: 10,
        fetch: () =>
          Promise.resolve(
            new Response(body, {
              headers: { 'content-type': 'application/json' },
            }),
          ),
      }),
    ).rejects.toThrow('GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT');
  });
});

describe('exclusive and atomic refresh-token persistence', () => {
  it('creates exclusively, refuses collision, and rotates atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-bootstrap-'));
    const outputFile = join(directory, 'refresh-token');
    const events: string[] = [];
    const operations = deterministicFileOperations(events);
    try {
      await persistGmailRefreshToken({
        outputFile,
        refreshToken: REFRESH_TOKEN,
        operations,
      });
      expect(await readFile(outputFile, 'utf8')).toBe(REFRESH_TOKEN);
      expect(events.slice(0, 5)).toEqual([
        'restrict',
        'write',
        'sync',
        'close',
        'link',
      ]);
      await expect(
        persistGmailRefreshToken({
          outputFile,
          refreshToken: 'replacement',
          operations,
        }),
      ).rejects.toThrow('GMAIL_OAUTH_BOOTSTRAP_OUTPUT_COLLISION');
      expect(await readFile(outputFile, 'utf8')).toBe(REFRESH_TOKEN);
      expect((await readdir(directory)).sort()).toEqual(['refresh-token']);
      await persistGmailRefreshToken({
        outputFile,
        refreshToken: 'replacement',
        rotate: true,
        operations,
      });
      expect(await readFile(outputFile, 'utf8')).toBe('replacement');
      expect(events.at(-5)).toBe('restrict');
      expect(events.at(-4)).toBe('write');
      expect(events.at(-1)).toBe('rename');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the old token when atomic rotation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-bootstrap-'));
    const outputFile = join(directory, 'refresh-token');
    await writeFile(outputFile, 'old-token', { mode: 0o600 });
    const operations: GmailOAuthBootstrapFileOperations = {
      open: (path) => open(path, 'wx', 0o600),
      write: (handle, value) => handle.writeFile(value, { encoding: 'utf8' }),
      sync: (handle) => handle.sync(),
      close: (handle) => handle.close(),
      stat: (handle) => handle.stat(),
      link,
      rename: () =>
        Promise.reject(Object.assign(new Error('fixture'), { code: 'EIO' })),
      unlink,
      lstat,
      restrict: () => Promise.resolve(),
    };
    try {
      await expect(
        persistGmailRefreshToken({
          outputFile,
          refreshToken: 'new-token',
          rotate: true,
          operations,
        }),
      ).rejects.toThrow('GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED');
      expect(await readFile(outputFile, 'utf8')).toBe('old-token');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes no secret bytes when pre-write restriction fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-bootstrap-'));
    const outputFile = join(directory, 'refresh-token');
    const events: string[] = [];
    const operations = deterministicFileOperations(events);
    const failingOperations: GmailOAuthBootstrapFileOperations = {
      ...operations,
      restrict: () => {
        events.push('restrict-failed');
        return Promise.reject(new Error('fixture restriction failure'));
      },
    };
    try {
      await expect(
        persistGmailRefreshToken({
          outputFile,
          refreshToken: REFRESH_TOKEN,
          operations: failingOperations,
        }),
      ).rejects.toThrow('GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED');
      expect(events).not.toContain('write');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes no secret bytes if the restricted path no longer names the open handle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-bootstrap-'));
    const outputFile = join(directory, 'refresh-token');
    const decoyFile = join(directory, 'decoy');
    await writeFile(decoyFile, 'decoy', { mode: 0o600 });
    const events: string[] = [];
    const operations = deterministicFileOperations(events);
    const mismatchedOperations: GmailOAuthBootstrapFileOperations = {
      ...operations,
      lstat: (path) => (path === outputFile ? lstat(path) : lstat(decoyFile)),
    };
    try {
      await expect(
        persistGmailRefreshToken({
          outputFile,
          refreshToken: REFRESH_TOKEN,
          operations: mismatchedOperations,
        }),
      ).rejects.toThrow('GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED');
      expect(events).toContain('restrict');
      expect(events).not.toContain('write');
      expect(await readFile(decoyFile, 'utf8')).toBe('decoy');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['partial-write', 'sync', 'close'] as const)(
    'still unlinks a secret-bearing temporary after %s and cleanup-close failures',
    async (stage) => {
      const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-bootstrap-'));
      const outputFile = join(directory, 'refresh-token');
      const events: string[] = [];
      const operations = cleanupFailureFileOperations(stage, events);
      try {
        await expect(
          persistGmailRefreshToken({
            outputFile,
            refreshToken: REFRESH_TOKEN,
            operations,
          }),
        ).rejects.toMatchObject({
          code: 'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED',
        });
        expect(events.filter((event) => event === 'close')).toHaveLength(
          stage === 'close' ? 2 : 1,
        );
        expect(events.at(-1)).toBe('unlink');
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('redacts cleanup-close and unlink failures without replacing the primary issue code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-bootstrap-'));
    const outputFile = join(directory, 'refresh-token');
    const events: string[] = [];
    const operations = cleanupFailureFileOperations('sync', events, false);
    let caught: unknown;
    try {
      try {
        await persistGmailRefreshToken({
          outputFile,
          refreshToken: REFRESH_TOKEN,
          operations,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GmailOAuthBootstrapError);
      expect(caught).toMatchObject({
        code: 'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED',
      });
      expect(events.at(-2)).toBe('close');
      expect(events.at(-1)).toBe('unlink');
      expect(String(caught)).not.toContain('private cleanup-close detail');
      expect(String(caught)).not.toContain('private cleanup-unlink detail');
      expect(String(caught)).not.toContain(REFRESH_TOKEN);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

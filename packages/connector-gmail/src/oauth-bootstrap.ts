import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { GMAIL_READ_ONLY_OAUTH_SCOPES } from './descriptor.js';

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI =
  'http://localhost:3000/api/oauth/google/callback';
export const GMAIL_OAUTH_BOOTSTRAP_BIND_ADDRESS = '127.0.0.1';
export const GMAIL_OAUTH_BOOTSTRAP_PORT = 3000;
export const GMAIL_OAUTH_BOOTSTRAP_CALLBACK_PATH = '/api/oauth/google/callback';
export const GMAIL_OAUTH_BOOTSTRAP_CALLBACK_DEADLINE_MILLISECONDS = 300_000;
export const GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT_MILLISECONDS = 15_000;
export const GMAIL_OAUTH_BOOTSTRAP_MAX_REQUEST_TARGET_BYTES = 8_192;
export const GMAIL_OAUTH_BOOTSTRAP_MAX_CODE_BYTES = 4_096;
export const GMAIL_OAUTH_BOOTSTRAP_MAX_TOKEN_RESPONSE_BYTES = 32_768;
export const GMAIL_OAUTH_BOOTSTRAP_SCOPE =
  'https://www.googleapis.com/auth/gmail.readonly';

export type GmailOAuthBootstrapIssueCode =
  | 'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_BIND_FAILED'
  | 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_REPLAY'
  | 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_TIMEOUT'
  | 'GMAIL_OAUTH_BOOTSTRAP_BROWSER_OPEN_FAILED'
  | 'GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_COLLISION'
  | 'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED'
  | 'GMAIL_OAUTH_BOOTSTRAP_PROVIDER_ERROR'
  | 'GMAIL_OAUTH_BOOTSTRAP_SCOPE_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_CONTENT_TYPE_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_MISSING_REFRESH_TOKEN'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_REDIRECT_FORBIDDEN'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_RESPONSE_TOO_LARGE'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_STATUS_INVALID'
  | 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT'
  | 'GMAIL_OAUTH_BOOTSTRAP_UNEXPECTED_FAILURE';

export class GmailOAuthBootstrapError extends Error {
  public constructor(public readonly code: GmailOAuthBootstrapIssueCode) {
    super(code);
    this.name = 'GmailOAuthBootstrapError';
  }
}

export interface GmailOAuthBootstrapClient {
  readonly applicationType: 'installed' | 'web';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: typeof GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  }
  return value as Readonly<Record<string, unknown>>;
}

export function parseGmailOAuthClientJson(
  raw: string,
): GmailOAuthBootstrapClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  }
  const root = record(parsed);
  if (!['installed', 'web'].includes(Object.keys(root)[0] ?? '')) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  }
  const installed = root.installed;
  const web = root.web;
  if (
    Object.keys(root).length !== 1 ||
    Number(installed !== undefined) + Number(web !== undefined) !== 1
  ) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  }
  const applicationType = installed === undefined ? 'web' : 'installed';
  const client = record(installed ?? web);
  const clientId = client.client_id;
  const clientSecret = client.client_secret;
  const redirectUris = client.redirect_uris;
  const redirectUri: unknown = Array.isArray(redirectUris)
    ? redirectUris[0]
    : undefined;
  if (
    typeof clientId !== 'string' ||
    clientId.trim().length === 0 ||
    clientId.length > 2_048 ||
    typeof clientSecret !== 'string' ||
    clientSecret.trim().length === 0 ||
    clientSecret.length > 4_096 ||
    !Array.isArray(redirectUris) ||
    redirectUris.length !== 1 ||
    redirectUri !== GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI
  ) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  }
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== 'http:' ||
    redirect.hostname !== 'localhost' ||
    redirect.port !== String(GMAIL_OAUTH_BOOTSTRAP_PORT) ||
    redirect.pathname !== GMAIL_OAUTH_BOOTSTRAP_CALLBACK_PATH ||
    redirect.search !== '' ||
    redirect.hash !== '' ||
    redirect.username !== '' ||
    redirect.password !== ''
  ) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CLIENT_INVALID');
  }
  return {
    applicationType,
    clientId,
    clientSecret,
    redirectUri: GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI,
  };
}

export interface GmailOAuthBootstrapProof {
  readonly state: string;
  readonly pkceVerifier: string;
  readonly pkceChallenge: string;
}

export function createGmailOAuthBootstrapProof(): GmailOAuthBootstrapProof {
  const state = randomBytes(32).toString('base64url');
  const pkceVerifier = randomBytes(32).toString('base64url');
  return {
    state,
    pkceVerifier,
    pkceChallenge: createHash('sha256')
      .update(pkceVerifier, 'ascii')
      .digest('base64url'),
  };
}

export function buildGmailAuthorizationUrl(input: {
  readonly clientId: string;
  readonly state: string;
  readonly pkceChallenge: string;
  readonly loginHint?: string;
}): string {
  if (
    input.clientId.length === 0 ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(input.state) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.pkceChallenge) ||
    GMAIL_READ_ONLY_OAUTH_SCOPES.length !== 1 ||
    GMAIL_READ_ONLY_OAUTH_SCOPES[0] !== GMAIL_OAUTH_BOOTSTRAP_SCOPE
  ) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_OAUTH_BOOTSTRAP_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.pkceChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('prompt', 'consent');
  if (input.loginHint !== undefined) {
    const loginHint = input.loginHint.trim();
    if (
      loginHint.length === 0 ||
      loginHint.length > 320 ||
      !/^[^@\s]+@[^@\s]+$/u.test(loginHint)
    ) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
      );
    }
    url.searchParams.set('login_hint', loginHint);
  }
  return url.toString();
}

export interface GmailOAuthCallbackRequest {
  readonly method?: string;
  readonly target?: string;
  readonly hostHeaders: readonly string[];
  readonly contentLength?: string;
  readonly transferEncoding?: string;
}

export type GmailOAuthCallbackDecision =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'invalid'; readonly code: GmailOAuthBootstrapIssueCode }
  | {
      readonly kind: 'oauth_error';
      readonly code: GmailOAuthBootstrapIssueCode;
    };

function exactSafeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export class GmailOAuthCallbackGate {
  #completed = false;

  public constructor(private readonly expectedState: string) {}

  public evaluate(
    request: GmailOAuthCallbackRequest,
  ): GmailOAuthCallbackDecision {
    if (this.#completed) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_REPLAY',
      };
    }
    const target = request.target ?? '';
    if (
      request.method !== 'GET' ||
      request.hostHeaders.length !== 1 ||
      request.hostHeaders[0]?.toLowerCase() !== 'localhost:3000' ||
      target.length === 0 ||
      !target.startsWith('/') ||
      target.startsWith('//') ||
      Buffer.byteLength(target, 'utf8') >
        GMAIL_OAUTH_BOOTSTRAP_MAX_REQUEST_TARGET_BYTES ||
      /%(?![0-9A-Fa-f]{2})/u.test(target) ||
      (request.contentLength !== undefined && request.contentLength !== '0') ||
      request.transferEncoding !== undefined
    ) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    const querySeparator = target.indexOf('?');
    const rawPath =
      querySeparator === -1 ? target : target.slice(0, querySeparator);
    const rawQuery =
      querySeparator === -1 ? '' : target.slice(querySeparator + 1);
    if (rawPath !== GMAIL_OAUTH_BOOTSTRAP_CALLBACK_PATH) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    try {
      decodeURIComponent(rawQuery);
    } catch {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    let url: URL;
    try {
      url = new URL(target, GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI);
    } catch {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    if (
      url.origin !== 'http://localhost:3000' ||
      url.pathname !== GMAIL_OAUTH_BOOTSTRAP_CALLBACK_PATH ||
      url.hash !== ''
    ) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    const parameters = new Map<string, string[]>();
    for (const [key, value] of url.searchParams) {
      parameters.set(key, [...(parameters.get(key) ?? []), value]);
    }
    if ([...parameters.values()].some((values) => values.length !== 1)) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    const state = parameters.get('state')?.[0];
    if (
      state === undefined ||
      state.length > 128 ||
      !exactSafeEqual(state, this.expectedState)
    ) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    if (parameters.has('error')) {
      const allowed = new Set([
        'state',
        'error',
        'error_description',
        'error_uri',
      ]);
      const error = parameters.get('error')?.[0] ?? '';
      if (
        [...parameters.keys()].some((key) => !allowed.has(key)) ||
        error.length === 0 ||
        error.length > 256 ||
        (parameters.get('error_description')?.[0]?.length ?? 0) > 1_024 ||
        (parameters.get('error_uri')?.[0]?.length ?? 0) > 2_048
      ) {
        return {
          kind: 'invalid',
          code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
        };
      }
      this.#completed = true;
      return {
        kind: 'oauth_error',
        code: 'GMAIL_OAUTH_BOOTSTRAP_PROVIDER_ERROR',
      };
    }
    const code = parameters.get('code')?.[0];
    if (
      parameters.size !== 2 ||
      code === undefined ||
      code.length === 0 ||
      Buffer.byteLength(code, 'utf8') > GMAIL_OAUTH_BOOTSTRAP_MAX_CODE_BYTES
    ) {
      return {
        kind: 'invalid',
        code: 'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
      };
    }
    this.#completed = true;
    return { kind: 'code', code };
  }
}

const SUCCESS_HTML =
  '<!doctype html><html><body><h1>Gmail authorization received</h1><p>You may close this window.</p></body></html>';
const FAILURE_HTML =
  '<!doctype html><html><body><h1>Gmail authorization was not accepted</h1><p>Return to the terminal and try again.</p></body></html>';

function hostHeaderValues(request: IncomingMessage): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'host') {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function respond(
  response: ServerResponse,
  status: number,
  html: string,
  after: () => void = () => undefined,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  response.setHeader('Connection', 'close');
  let finished = false;
  const complete = () => {
    if (finished) return;
    finished = true;
    after();
  };
  response.once('close', complete);
  response.once('error', complete);
  response.end(html, complete);
}

export interface GmailOAuthCallbackServer {
  readonly callback: Promise<string>;
  close(): Promise<void>;
}

export async function startGmailOAuthCallbackServer(input: {
  readonly expectedState: string;
  readonly deadlineMilliseconds?: number;
}): Promise<GmailOAuthCallbackServer> {
  const deadline =
    input.deadlineMilliseconds ??
    GMAIL_OAUTH_BOOTSTRAP_CALLBACK_DEADLINE_MILLISECONDS;
  if (
    !/^[A-Za-z0-9_-]{43,128}$/u.test(input.expectedState) ||
    deadline < 1 ||
    deadline > GMAIL_OAUTH_BOOTSTRAP_CALLBACK_DEADLINE_MILLISECONDS
  ) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
  const gate = new GmailOAuthCallbackGate(input.expectedState);
  let resolveCallback: (code: string) => void = () => undefined;
  let rejectCallback: (error: GmailOAuthBootstrapError) => void = () =>
    undefined;
  let settled = false;
  const callback = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCallback = resolvePromise;
    rejectCallback = rejectPromise;
  });
  const sockets = new Set<Socket>();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    for (const socket of sockets) socket.destroy();
    shutdownPromise = new Promise<void>((resolvePromise) => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close(() => resolvePromise());
    });
    return shutdownPromise;
  };
  const server = createServer((request, response) => {
    const decision = gate.evaluate({
      method: request.method,
      target: request.url,
      hostHeaders: hostHeaderValues(request),
      ...(request.headers['content-length'] === undefined
        ? {}
        : { contentLength: request.headers['content-length'] }),
      ...(request.headers['transfer-encoding'] === undefined
        ? {}
        : { transferEncoding: request.headers['transfer-encoding'] }),
    });
    if (decision.kind === 'invalid') {
      respond(
        response,
        decision.code.endsWith('REPLAY') ? 409 : 400,
        FAILURE_HTML,
      );
      return;
    }
    respond(
      response,
      decision.kind === 'code' ? 200 : 400,
      decision.kind === 'code' ? SUCCESS_HTML : FAILURE_HTML,
      () => {
        if (!settled) {
          settled = true;
          if (decision.kind === 'code') resolveCallback(decision.code);
          else rejectCallback(new GmailOAuthBootstrapError(decision.code));
        }
        void shutdown();
      },
    );
  });
  server.maxHeadersCount = 32;
  server.requestTimeout = deadline;
  server.headersTimeout = Math.min(deadline, 10_000);
  server.keepAliveTimeout = 1;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = () => {
        server.off('listening', onListening);
        rejectPromise(
          new GmailOAuthBootstrapError(
            'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_BIND_FAILED',
          ),
        );
      };
      const onListening = () => {
        server.off('error', onError);
        resolvePromise();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(
        GMAIL_OAUTH_BOOTSTRAP_PORT,
        GMAIL_OAUTH_BOOTSTRAP_BIND_ADDRESS,
      );
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
  server.on('error', () => {
    if (settled) return;
    settled = true;
    rejectCallback(
      new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_BIND_FAILED',
      ),
    );
    void shutdown();
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCallback(
        new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_CALLBACK_TIMEOUT'),
      );
      void shutdown();
    }
  }, deadline);
  void callback.finally(() => clearTimeout(timer)).catch(() => undefined);
  return {
    callback,
    close: () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectCallback(
          new GmailOAuthBootstrapError(
            'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_INVALID',
          ),
        );
      }
      return shutdown();
    },
  };
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_TOKEN_RESPONSE_TOO_LARGE',
    );
  }
  if (response.body === null) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new GmailOAuthBootstrapError(
          'GMAIL_OAUTH_BOOTSTRAP_TOKEN_RESPONSE_TOO_LARGE',
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GmailOAuthBootstrapError) throw error;
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    );
  } catch {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID');
  }
}

async function withAbortSignal<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT');
  }
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () =>
      reject(
        new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT'),
      );
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (rejectOnAbort !== undefined) {
      signal.removeEventListener('abort', rejectOnAbort);
    }
  }
}

export interface GmailOAuthTokenResult {
  readonly refreshToken: string;
  readonly scopes: readonly [typeof GMAIL_OAUTH_BOOTSTRAP_SCOPE];
  readonly tokenType: 'Bearer';
}

function isSafeRefreshToken(value: string): boolean {
  if (value.length === 0 || value.length > 4_096) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}

export async function exchangeGmailAuthorizationCode(input: {
  readonly client: GmailOAuthBootstrapClient;
  readonly code: string;
  readonly pkceVerifier: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
}): Promise<GmailOAuthTokenResult> {
  if (
    input.code.length === 0 ||
    Buffer.byteLength(input.code, 'utf8') >
      GMAIL_OAUTH_BOOTSTRAP_MAX_CODE_BYTES ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.pkceVerifier)
  ) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
  const timeout =
    input.timeoutMilliseconds ??
    GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT_MILLISECONDS;
  if (
    timeout < 1 ||
    timeout > GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT_MILLISECONDS
  ) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
  const body = new URLSearchParams({
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    code: input.code,
    code_verifier: input.pkceVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.client.redirectUri,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new GmailOAuthBootstrapError(
      controller.signal.aborted
        ? 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT'
        : 'GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID',
    );
  }
  try {
    if (response.status >= 300 && response.status < 400) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_TOKEN_REDIRECT_FORBIDDEN',
      );
    }
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_TOKEN_CONTENT_TYPE_INVALID',
      );
    }
    const raw = await withAbortSignal(
      () =>
        readBoundedResponseBody(
          response,
          GMAIL_OAUTH_BOOTSTRAP_MAX_TOKEN_RESPONSE_BYTES,
        ),
      controller.signal,
    );
    if (response.status !== 200) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_TOKEN_STATUS_INVALID',
      );
    }
    let payload: Readonly<Record<string, unknown>>;
    try {
      payload = record(JSON.parse(raw) as unknown);
    } catch {
      throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID');
    }
    const refreshToken = payload.refresh_token;
    const tokenType = payload.token_type;
    const scope = payload.scope;
    if (typeof refreshToken !== 'string' || !isSafeRefreshToken(refreshToken)) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_TOKEN_MISSING_REFRESH_TOKEN',
      );
    }
    if (tokenType !== 'Bearer' || typeof scope !== 'string') {
      throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_INVALID');
    }
    const scopes = scope.split(/\s+/u).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== GMAIL_OAUTH_BOOTSTRAP_SCOPE) {
      throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_SCOPE_INVALID');
    }
    return {
      refreshToken,
      scopes: [GMAIL_OAUTH_BOOTSTRAP_SCOPE],
      tokenType: 'Bearer',
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new GmailOAuthBootstrapError('GMAIL_OAUTH_BOOTSTRAP_TOKEN_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface GmailOAuthBootstrapFileOperations {
  open(path: string): Promise<FileHandle>;
  write(handle: FileHandle, value: string): Promise<void>;
  sync(handle: FileHandle): Promise<void>;
  close(handle: FileHandle): Promise<void>;
  stat(handle: FileHandle): ReturnType<FileHandle['stat']>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): ReturnType<typeof lstat>;
  restrict(path: string): Promise<void>;
}

const defaultFileOperations: GmailOAuthBootstrapFileOperations = {
  open: (path) => open(path, 'wx', 0o600),
  write: (handle, value) => handle.writeFile(value, { encoding: 'utf8' }),
  sync: (handle) => handle.sync(),
  close: (handle) => handle.close(),
  stat: (handle) => handle.stat(),
  link,
  rename,
  unlink,
  lstat,
  restrict: async (path) => {
    await chmod(path, 0o600);
    if (process.platform !== 'win32') return;
    const username = process.env.USERNAME;
    if (username === undefined || username.length === 0) {
      throw new Error('principal unavailable');
    }
    const principal =
      process.env.USERDOMAIN === undefined ||
      process.env.USERDOMAIN.length === 0
        ? username
        : `${process.env.USERDOMAIN}\\${username}`;
    await promisify(execFile)(
      'icacls.exe',
      [path, '/inheritance:r', '/grant:r', `${principal}:(F)`, '/Q'],
      { windowsHide: true },
    );
  },
};

function isFileError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function assertRestrictedHandleStillNamesPath(
  handle: FileHandle,
  path: string,
  operations: GmailOAuthBootstrapFileOperations,
): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    operations.stat(handle),
    operations.lstat(path),
  ]);
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino === 0 ||
    handleStat.ino !== pathStat.ino
  ) {
    throw new Error('temporary file identity changed');
  }
}

export async function persistGmailRefreshToken(input: {
  readonly outputFile: string;
  readonly refreshToken: string;
  readonly rotate?: boolean;
  readonly operations?: GmailOAuthBootstrapFileOperations;
}): Promise<void> {
  if (
    input.outputFile.length === 0 ||
    !isSafeRefreshToken(input.refreshToken)
  ) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
  const operations = input.operations ?? defaultFileOperations;
  const outputFile = resolve(input.outputFile);
  if (input.rotate === true) {
    try {
      const existing = await operations.lstat(outputFile);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error('unsafe');
      }
    } catch {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_COLLISION',
      );
    }
  }
  const temporary = join(
    dirname(outputFile),
    `.${basename(outputFile)}.oauth-bootstrap-${randomBytes(16).toString('hex')}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await operations.open(temporary);
    await operations.restrict(temporary);
    await assertRestrictedHandleStillNamesPath(handle, temporary, operations);
    await operations.write(handle, input.refreshToken);
    await operations.sync(handle);
    await operations.close(handle);
    handle = undefined;
    if (input.rotate === true) {
      await operations.rename(temporary, outputFile);
    } else {
      await operations.link(temporary, outputFile);
      await operations.unlink(temporary);
    }
  } catch (error) {
    if (handle !== undefined) {
      try {
        await operations.close(handle);
      } catch {
        // Cleanup close errors are intentionally redacted.
      }
    }
    try {
      await operations.unlink(temporary);
    } catch {
      // Cleanup unlink errors are intentionally redacted.
    }
    throw new GmailOAuthBootstrapError(
      isFileError(error, 'EEXIST')
        ? 'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_COLLISION'
        : 'GMAIL_OAUTH_BOOTSTRAP_OUTPUT_WRITE_FAILED',
    );
  }
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isFileError(error, 'ENOENT')) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
      );
    }
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

export async function assertGmailOAuthBootstrapPathSeparation(paths: {
  readonly oauthClientFile: string;
  readonly outputFile: string;
  readonly expectedAccountFile?: string;
}): Promise<void> {
  const canonical = await Promise.all(
    [paths.oauthClientFile, paths.outputFile, paths.expectedAccountFile]
      .filter((path): path is string => path !== undefined)
      .map(canonicalPath),
  );
  const comparable = canonical.map((path) =>
    process.platform === 'win32' ? path.toLowerCase() : path,
  );
  if (new Set(comparable).size !== comparable.length) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
}

export function gmailOAuthBootstrapHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

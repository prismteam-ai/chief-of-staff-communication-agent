import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseGmailOAuthBootstrapCli,
  runGmailOAuthBootstrapCli,
} from './oauth-bootstrap-cli.js';
import {
  GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI,
  GMAIL_OAUTH_BOOTSTRAP_SCOPE,
  GmailOAuthBootstrapError,
  persistGmailRefreshToken,
  type GmailOAuthBootstrapFileOperations,
} from './oauth-bootstrap.js';

const CLIENT_ID = 'cli-client.apps.example.invalid';
const CLIENT_SECRET = ['cli', 'fixture', 'secret', 'not', 'real'].join('-');
const EXPECTED_ACCOUNT = 'expected@example.invalid';
const REFRESH_TOKEN = 'cli-refresh-token-not-real';
const CALLBACK_CODE = 'cli-code-not-real';

const deterministicFileOperations: GmailOAuthBootstrapFileOperations = {
  open: (path) => open(path, 'wx', 0o600),
  write: (handle, value) => handle.writeFile(value, { encoding: 'utf8' }),
  sync: (handle) => handle.sync(),
  close: (handle) => handle.close(),
  stat: (handle) => handle.stat(),
  link,
  rename,
  unlink,
  lstat,
  restrict: (path) => chmod(path, 0o600),
};

function clientJson(): string {
  return JSON.stringify({
    web: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: [GMAIL_OAUTH_BOOTSTRAP_REDIRECT_URI],
    },
  });
}

describe('Gmail OAuth bootstrap CLI', () => {
  it('accepts only explicit path and boolean flags', () => {
    expect(
      parseGmailOAuthBootstrapCli([
        '--oauth-client-file',
        'client.json',
        '--output-file',
        'refresh-token',
        '--expected-account-file',
        'expected-account',
        '--rotate',
        '--open-browser',
      ]),
    ).toEqual({
      oauthClientFile: 'client.json',
      outputFile: 'refresh-token',
      expectedAccountFile: 'expected-account',
      rotate: true,
      openBrowser: true,
    });
    expect(() =>
      parseGmailOAuthBootstrapCli([
        '--oauth-client-file',
        'client.json',
        '--output-file',
        'refresh-token',
        '--refresh-token',
        REFRESH_TOKEN,
      ]),
    ).toThrow('GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID');
  });

  it('chains consent, exchange, and persistence without emitting PII or secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-cli-'));
    const clientFile = join(directory, 'client.json');
    const expectedAccountFile = join(directory, 'expected-account');
    const outputFile = join(directory, 'refresh-token');
    await writeFile(clientFile, clientJson());
    await writeFile(expectedAccountFile, EXPECTED_ACCOUNT);
    const output: string[] = [];
    const browserUrls: string[] = [];
    try {
      const status = await runGmailOAuthBootstrapCli(
        [
          '--oauth-client-file',
          clientFile,
          '--output-file',
          outputFile,
          '--expected-account-file',
          expectedAccountFile,
          '--open-browser',
        ],
        {
          now: () => '2026-07-18T12:00:00.000Z',
          writeOutput: (line) => output.push(line),
          openBrowser: (url) => {
            browserUrls.push(url);
            return Promise.resolve();
          },
          startCallbackServer: () =>
            Promise.resolve({
              callback: Promise.resolve(CALLBACK_CODE),
              close: () => Promise.resolve(),
            }),
          exchangeCode: (input) => {
            expect(input.code).toBe(CALLBACK_CODE);
            expect(input.client.clientSecret).toBe(CLIENT_SECRET);
            expect(input.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            return Promise.resolve({
              refreshToken: REFRESH_TOKEN,
              scopes: [GMAIL_OAUTH_BOOTSTRAP_SCOPE],
              tokenType: 'Bearer',
            });
          },
          persistToken: (input) =>
            persistGmailRefreshToken({
              ...input,
              operations: deterministicFileOperations,
            }),
        },
      );
      expect(status).toBe(0);
      expect(await readFile(outputFile, 'utf8')).toBe(REFRESH_TOKEN);
      expect(browserUrls).toHaveLength(1);
      expect(new URL(browserUrls[0] ?? '').searchParams.get('login_hint')).toBe(
        EXPECTED_ACCOUNT,
      );
      expect(output).toHaveLength(2);
      const consent = JSON.parse(output[0] ?? '{}') as {
        readonly authorizationUrl?: string;
      };
      expect(consent.authorizationUrl).toBeDefined();
      expect(consent.authorizationUrl).not.toContain(EXPECTED_ACCOUNT);
      const completion = output[1] ?? '';
      expect(completion).not.toContain(CLIENT_ID);
      expect(completion).not.toContain(CLIENT_SECRET);
      expect(completion).not.toContain(EXPECTED_ACCOUNT);
      expect(completion).not.toContain(REFRESH_TOKEN);
      expect(completion).not.toContain(CALLBACK_CODE);
      expect(JSON.parse(completion)).toMatchObject({
        event: 'gmail_oauth_bootstrap_complete',
        status: 'pass',
        scopes: [GMAIL_OAUTH_BOOTSTRAP_SCOPE],
        outputFileBasename: 'refresh-token',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not open a browser without the explicit flag and redacts failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-cli-'));
    const clientFile = join(directory, 'client.json');
    const outputFile = join(directory, 'refresh-token');
    await writeFile(clientFile, clientJson());
    const output: string[] = [];
    let browserCalls = 0;
    try {
      const status = await runGmailOAuthBootstrapCli(
        ['--oauth-client-file', clientFile, '--output-file', outputFile],
        {
          writeOutput: (line) => output.push(line),
          openBrowser: () => {
            browserCalls += 1;
            return Promise.resolve();
          },
          startCallbackServer: () =>
            Promise.resolve({
              callback: Promise.resolve(CALLBACK_CODE),
              close: () => Promise.resolve(),
            }),
          exchangeCode: () =>
            Promise.reject(
              new GmailOAuthBootstrapError(
                'GMAIL_OAUTH_BOOTSTRAP_TOKEN_STATUS_INVALID',
              ),
            ),
        },
      );
      expect(status).toBe(1);
      expect(browserCalls).toBe(0);
      const failure = output.at(-1) ?? '';
      expect(failure).toContain('GMAIL_OAUTH_BOOTSTRAP_TOKEN_STATUS_INVALID');
      expect(failure).not.toContain(CLIENT_SECRET);
      expect(failure).not.toContain(CALLBACK_CODE);
      expect(failure).not.toContain(REFRESH_TOKEN);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not exchange or persist after callback deadline rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-oauth-cli-'));
    const clientFile = join(directory, 'client.json');
    const outputFile = join(directory, 'refresh-token');
    await writeFile(clientFile, clientJson());
    let exchangeCalls = 0;
    let persistCalls = 0;
    try {
      const status = await runGmailOAuthBootstrapCli(
        ['--oauth-client-file', clientFile, '--output-file', outputFile],
        {
          writeOutput: () => undefined,
          startCallbackServer: () =>
            Promise.resolve({
              callback: Promise.reject(
                new GmailOAuthBootstrapError(
                  'GMAIL_OAUTH_BOOTSTRAP_CALLBACK_TIMEOUT',
                ),
              ),
              close: () => Promise.resolve(),
            }),
          exchangeCode: () => {
            exchangeCalls += 1;
            return Promise.reject(new Error('must not exchange'));
          },
          persistToken: () => {
            persistCalls += 1;
            return Promise.reject(new Error('must not persist'));
          },
        },
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      expect(status).toBe(1);
      expect(exchangeCalls).toBe(0);
      expect(persistCalls).toBe(0);
      await expect(readFile(outputFile, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

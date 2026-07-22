import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertGmailOAuthBootstrapPathSeparation,
  buildGmailAuthorizationUrl,
  createGmailOAuthBootstrapProof,
  exchangeGmailAuthorizationCode,
  GmailOAuthBootstrapError,
  gmailOAuthBootstrapHash,
  parseGmailOAuthClientJson,
  persistGmailRefreshToken,
  startGmailOAuthCallbackServer,
  type GmailOAuthBootstrapIssueCode,
} from './oauth-bootstrap.js';

export interface GmailOAuthBootstrapCliOptions {
  readonly oauthClientFile: string;
  readonly outputFile: string;
  readonly expectedAccountFile?: string;
  readonly rotate: boolean;
  readonly openBrowser: boolean;
}

const valueFlags = new Set([
  '--oauth-client-file',
  '--output-file',
  '--expected-account-file',
]);
const booleanFlags = new Set(['--rotate', '--open-browser']);

export function parseGmailOAuthBootstrapCli(
  argv: readonly string[],
): GmailOAuthBootstrapCliOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
      );
    }
    if (booleanFlags.has(flag)) {
      if (booleans.has(flag)) {
        throw new GmailOAuthBootstrapError(
          'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
        );
      }
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new GmailOAuthBootstrapError(
        'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
      );
    }
    values.set(flag, value);
    index += 1;
  }
  const oauthClientFile = values.get('--oauth-client-file');
  const outputFile = values.get('--output-file');
  if (oauthClientFile === undefined || outputFile === undefined) {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
  return {
    oauthClientFile,
    outputFile,
    ...(values.get('--expected-account-file') === undefined
      ? {}
      : { expectedAccountFile: values.get('--expected-account-file') }),
    rotate: booleans.has('--rotate'),
    openBrowser: booleans.has('--open-browser'),
  };
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  try {
    const value = await readFile(path);
    if (value.byteLength === 0 || value.byteLength > maximumBytes) {
      throw new Error('bounded');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_ARGUMENT_INVALID',
    );
  }
}

export async function openDefaultBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'win32'
      ? 'rundll32.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once('spawn', resolvePromise);
      child.once('error', rejectPromise);
    });
    child.unref();
  } catch {
    throw new GmailOAuthBootstrapError(
      'GMAIL_OAUTH_BOOTSTRAP_BROWSER_OPEN_FAILED',
    );
  }
}

function issueCode(error: unknown): GmailOAuthBootstrapIssueCode {
  return error instanceof GmailOAuthBootstrapError
    ? error.code
    : 'GMAIL_OAUTH_BOOTSTRAP_UNEXPECTED_FAILURE';
}

export interface GmailOAuthBootstrapCliDependencies {
  readonly now?: () => string;
  readonly writeOutput?: (line: string) => void;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly startCallbackServer?: typeof startGmailOAuthCallbackServer;
  readonly exchangeCode?: typeof exchangeGmailAuthorizationCode;
  readonly persistToken?: typeof persistGmailRefreshToken;
}

export async function runGmailOAuthBootstrapCli(
  argv: readonly string[],
  dependencies: GmailOAuthBootstrapCliDependencies = {},
): Promise<number> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const writeOutput =
    dependencies.writeOutput ?? ((line: string) => process.stdout.write(line));
  const startedAt = now();
  let callbackServer:
    Awaited<ReturnType<typeof startGmailOAuthCallbackServer>> | undefined;
  try {
    const options = parseGmailOAuthBootstrapCli(argv);
    await assertGmailOAuthBootstrapPathSeparation(options);
    const [clientRaw, loginHintRaw] = await Promise.all([
      readBoundedFile(options.oauthClientFile, 64 * 1_024),
      options.expectedAccountFile === undefined
        ? Promise.resolve(undefined)
        : readBoundedFile(options.expectedAccountFile, 1_024),
    ]);
    const client = parseGmailOAuthClientJson(clientRaw);
    const proof = createGmailOAuthBootstrapProof();
    const publicAuthorizationUrl = buildGmailAuthorizationUrl({
      clientId: client.clientId,
      state: proof.state,
      pkceChallenge: proof.pkceChallenge,
    });
    const browserAuthorizationUrl = buildGmailAuthorizationUrl({
      clientId: client.clientId,
      state: proof.state,
      pkceChallenge: proof.pkceChallenge,
      ...(loginHintRaw === undefined ? {} : { loginHint: loginHintRaw.trim() }),
    });
    callbackServer = await (
      dependencies.startCallbackServer ?? startGmailOAuthCallbackServer
    )({ expectedState: proof.state });
    writeOutput(
      `${JSON.stringify({
        schemaVersion: '1',
        event: 'gmail_oauth_consent_required',
        authorizationUrl: publicAuthorizationUrl,
        browserLoginHintApplied:
          loginHintRaw !== undefined && options.openBrowser,
        startedAt,
      })}\n`,
    );
    if (options.openBrowser) {
      await (dependencies.openBrowser ?? openDefaultBrowser)(
        browserAuthorizationUrl,
      );
    }
    const code = await callbackServer.callback;
    const token = await (
      dependencies.exchangeCode ?? exchangeGmailAuthorizationCode
    )({ client, code, pkceVerifier: proof.pkceVerifier });
    await (dependencies.persistToken ?? persistGmailRefreshToken)({
      outputFile: options.outputFile,
      refreshToken: token.refreshToken,
      rotate: options.rotate,
    });
    const completedAt = now();
    writeOutput(
      `${JSON.stringify({
        schemaVersion: '1',
        event: 'gmail_oauth_bootstrap_complete',
        status: 'pass',
        audienceHash: gmailOAuthBootstrapHash(client.clientId),
        scopes: [...token.scopes],
        outputFileBasename: basename(options.outputFile),
        outputPathHash: gmailOAuthBootstrapHash(resolve(options.outputFile)),
        startedAt,
        completedAt,
      })}\n`,
    );
    return 0;
  } catch (error) {
    writeOutput(
      `${JSON.stringify({
        schemaVersion: '1',
        event: 'gmail_oauth_bootstrap_complete',
        status: 'fail',
        issueCodes: [issueCode(error)],
        startedAt,
        completedAt: now(),
      })}\n`,
    );
    return 1;
  } finally {
    await callbackServer?.close();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  process.exitCode = await runGmailOAuthBootstrapCli(process.argv.slice(2));
}

import {
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acceptanceIssueCode,
  GmailAcceptanceError,
  runGmailReadOnlyAcceptance,
  type GmailAcceptanceCheckpoint,
  type GmailAcceptanceIssueCode,
  type GmailOAuthClientCredentials,
} from './acceptance.js';

export interface GmailAcceptanceCliOptions {
  readonly oauthClientFile?: string;
  readonly oauthClientEnv?: string;
  readonly refreshTokenFile?: string;
  readonly refreshTokenEnv?: string;
  readonly expectedAccountFile?: string;
  readonly expectedAccountEnv?: string;
  readonly checkpointFile: string;
  readonly maxItems?: number;
  readonly maxPages?: number;
}

const valueFlags = new Set([
  '--oauth-client-file',
  '--oauth-client-env',
  '--refresh-token-file',
  '--refresh-token-env',
  '--expected-account-file',
  '--expected-account-env',
  '--checkpoint-file',
  '--max-items',
  '--max-pages',
]);

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
  }
  return Number(value);
}

export function parseGmailAcceptanceCli(
  argv: readonly string[],
): GmailAcceptanceCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag?.toLowerCase().includes('send') === true) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_SEND_FORBIDDEN');
    }
    if (
      flag === undefined ||
      value === undefined ||
      !valueFlags.has(flag) ||
      values.has(flag) ||
      value.startsWith('--')
    ) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
    }
    values.set(flag, value);
  }
  const exactlyOne = (left: string, right: string) =>
    Number(values.has(left)) + Number(values.has(right)) === 1;
  if (
    !exactlyOne('--oauth-client-file', '--oauth-client-env') ||
    !exactlyOne('--refresh-token-file', '--refresh-token-env') ||
    !exactlyOne('--expected-account-file', '--expected-account-env') ||
    !values.has('--checkpoint-file')
  ) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
  }
  return {
    ...(values.get('--oauth-client-file') === undefined
      ? {}
      : { oauthClientFile: values.get('--oauth-client-file') }),
    ...(values.get('--oauth-client-env') === undefined
      ? {}
      : { oauthClientEnv: values.get('--oauth-client-env') }),
    ...(values.get('--refresh-token-file') === undefined
      ? {}
      : { refreshTokenFile: values.get('--refresh-token-file') }),
    ...(values.get('--refresh-token-env') === undefined
      ? {}
      : { refreshTokenEnv: values.get('--refresh-token-env') }),
    ...(values.get('--expected-account-file') === undefined
      ? {}
      : { expectedAccountFile: values.get('--expected-account-file') }),
    ...(values.get('--expected-account-env') === undefined
      ? {}
      : { expectedAccountEnv: values.get('--expected-account-env') }),
    checkpointFile: values.get('--checkpoint-file') ?? '',
    ...(values.get('--max-items') === undefined
      ? {}
      : { maxItems: parsePositiveInteger(values.get('--max-items') ?? '') }),
    ...(values.get('--max-pages') === undefined
      ? {}
      : { maxPages: parsePositiveInteger(values.get('--max-pages') ?? '') }),
  };
}

async function readSource(input: {
  readonly file?: string;
  readonly env?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly failureCode: GmailAcceptanceIssueCode;
}): Promise<string> {
  if (input.file !== undefined) {
    try {
      return await readFile(input.file, 'utf8');
    } catch {
      throw new GmailAcceptanceError(input.failureCode);
    }
  }
  const envName = input.env ?? '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
  }
  const value = input.environment[envName];
  if (value === undefined) {
    throw new GmailAcceptanceError(input.failureCode);
  }
  return value;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GmailAcceptanceError(
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

export function parseOAuthClientCredentials(
  raw: string,
): GmailOAuthClientCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GmailAcceptanceError(
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
  }
  const root = recordValue(parsed);
  const installed = root.installed;
  const web = root.web;
  if (Number(installed !== undefined) + Number(web !== undefined) !== 1) {
    throw new GmailAcceptanceError(
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
  }
  const applicationType = installed === undefined ? 'web' : 'installed';
  const credentials = recordValue(installed ?? web);
  const clientId = credentials.client_id;
  const clientSecret = credentials.client_secret;
  const redirectUris = credentials.redirect_uris;
  const redirectList = Array.isArray(redirectUris)
    ? (redirectUris as unknown[])
    : [];
  const redirectUri = redirectList[0];
  if (
    typeof clientId !== 'string' ||
    clientId.trim().length === 0 ||
    typeof clientSecret !== 'string' ||
    clientSecret.trim().length === 0 ||
    typeof redirectUri !== 'string' ||
    redirectList.length === 0 ||
    redirectList.some(
      (redirectUri) =>
        typeof redirectUri !== 'string' || redirectUri.trim().length === 0,
    )
  ) {
    throw new GmailAcceptanceError(
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
  }
  try {
    new URL(redirectUri);
  } catch {
    throw new GmailAcceptanceError(
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    applicationType,
  };
}

export function parseRefreshToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const token = recordValue(JSON.parse(trimmed) as unknown).refresh_token;
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('invalid');
      }
      return token.trim();
    } catch {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID');
    }
  }
  if (trimmed.length === 0) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID');
  }
  return trimmed;
}

async function canonicalPath(inputPath: string): Promise<string> {
  const absolutePath = resolve(inputPath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
    }
    const parent = dirname(absolutePath);
    if (parent === absolutePath) return absolutePath;
    return join(await canonicalPath(parent), basename(absolutePath));
  }
}

function comparablePath(inputPath: string): string {
  return process.platform === 'win32' ? inputPath.toLowerCase() : inputPath;
}

export async function assertGmailAcceptancePathSeparation(
  options: GmailAcceptanceCliOptions,
): Promise<void> {
  const paths = [
    options.oauthClientFile,
    options.refreshTokenFile,
    options.expectedAccountFile,
    options.checkpointFile,
    `${options.checkpointFile}.tmp`,
    `${options.checkpointFile}.bak`,
  ].filter((path): path is string => path !== undefined);
  const canonicalPaths = await Promise.all(paths.map(canonicalPath));
  const comparablePaths = canonicalPaths.map(comparablePath);
  if (new Set(comparablePaths).size !== comparablePaths.length) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
  }
}

async function readCheckpointCandidate(
  checkpointFile: string,
): Promise<GmailAcceptanceCheckpoint | undefined> {
  try {
    const raw = await readFile(checkpointFile, 'utf8');
    return JSON.parse(raw) as GmailAcceptanceCheckpoint;
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

export async function loadCheckpoint(
  checkpointFile: string,
): Promise<GmailAcceptanceCheckpoint | undefined> {
  const temporary = `${checkpointFile}.tmp`;
  const backup = `${checkpointFile}.bak`;
  try {
    const [primaryCheckpoint, backupCheckpoint, temporaryCheckpoint] =
      await Promise.all([
        readCheckpointCandidate(checkpointFile),
        readCheckpointCandidate(backup),
        readCheckpointCandidate(temporary),
      ]);
    if (primaryCheckpoint !== undefined) {
      await removeIfPresent(temporary);
      await removeIfPresent(backup);
      return primaryCheckpoint;
    }
    if (backupCheckpoint !== undefined) {
      await rename(backup, checkpointFile);
      await removeIfPresent(temporary);
      return backupCheckpoint;
    }
    if (temporaryCheckpoint !== undefined) {
      await rename(temporary, checkpointFile);
      return temporaryCheckpoint;
    }
    return undefined;
  } catch {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
}

export async function persistCheckpoint(
  checkpointFile: string,
  checkpoint: GmailAcceptanceCheckpoint,
): Promise<void> {
  const temporary = `${checkpointFile}.tmp`;
  const backup = `${checkpointFile}.bak`;
  let movedExisting = false;
  try {
    await loadCheckpoint(checkpointFile);
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await rename(checkpointFile, backup);
      movedExisting = true;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await rename(temporary, checkpointFile);
    if (movedExisting) await removeIfPresent(backup);
  } catch {
    if (movedExisting) {
      try {
        await removeIfPresent(checkpointFile);
        await rename(backup, checkpointFile);
        movedExisting = false;
      } catch {
        throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
      }
    }
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  } finally {
    try {
      await removeIfPresent(temporary);
      if (!movedExisting) await removeIfPresent(backup);
    } catch {
      // The primary checkpoint has already been recovered or persisted. A
      // cleanup failure remains content-free and must not expose a path/error.
    }
  }
}

function failureEvidence(code: GmailAcceptanceIssueCode, observedAt: string) {
  return {
    schemaVersion: '1',
    mode: 'read_only_acceptance',
    status: 'fail',
    issueCodes: [code],
    observedAt,
  } as const;
}

export async function runGmailAcceptanceCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const observedAt = new Date().toISOString();
  try {
    const options = parseGmailAcceptanceCli(argv);
    await assertGmailAcceptancePathSeparation(options);
    const [oauthRaw, refreshRaw, expectedRaw, checkpoint] = await Promise.all([
      readSource({
        file: options.oauthClientFile,
        env: options.oauthClientEnv,
        environment,
        failureCode: 'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
      }),
      readSource({
        file: options.refreshTokenFile,
        env: options.refreshTokenEnv,
        environment,
        failureCode: 'GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID',
      }),
      readSource({
        file: options.expectedAccountFile,
        env: options.expectedAccountEnv,
        environment,
        failureCode: 'GMAIL_ACCEPTANCE_EXPECTED_ACCOUNT_INVALID',
      }),
      loadCheckpoint(options.checkpointFile),
    ]);
    const result = await runGmailReadOnlyAcceptance({
      oauthClient: parseOAuthClientCredentials(oauthRaw),
      refreshToken: parseRefreshToken(refreshRaw),
      expectedAccount: expectedRaw.trim(),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    });
    await persistCheckpoint(options.checkpointFile, result.checkpoint);
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(failureEvidence(acceptanceIssueCode(error), observedAt))}\n`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  process.exitCode = await runGmailAcceptanceCli(process.argv.slice(2));
}

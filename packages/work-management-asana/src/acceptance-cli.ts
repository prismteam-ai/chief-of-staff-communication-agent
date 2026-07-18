import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acceptanceIssueCode,
  AsanaAcceptanceError,
  runAsanaAcceptance,
  validateControlledAuthorization,
  type AsanaAcceptanceIssueCode,
  type AsanaControlledAuthorization,
} from './acceptance.js';
import { AsanaRestTransport } from './transport.js';
import type {
  AsanaCredentialSource,
  AsanaTransport,
  AsanaTransportEvidence,
} from './types.js';

export interface AsanaAcceptanceCliOptions {
  readonly credentialFile: string;
  readonly workspaceGid?: string;
  readonly projectGid?: string;
  readonly maxItems?: number;
  readonly maxPages?: number;
  readonly allowControlledMutation: boolean;
  readonly authorizationFile?: string;
  readonly assessmentMarker?: string;
}

export const ASANA_ACCEPTANCE_MAX_CREDENTIAL_FILE_BYTES = 65_536;
export const ASANA_ACCEPTANCE_MAX_AUTHORIZATION_FILE_BYTES = 16_384;

const valueFlags = new Set([
  '--credential-file',
  '--workspace-gid',
  '--project-gid',
  '--max-items',
  '--max-pages',
  '--authorization-file',
  '--assessment-marker',
]);

function positiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
  }
  return Number(value);
}

function gid(value: string): string {
  if (!/^[0-9]{1,64}$/u.test(value)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
  }
  return value;
}

function marker(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/u.test(value)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_MARKER_INVALID');
  }
  return value;
}

export function parseAsanaAcceptanceCli(
  argv: readonly string[],
): AsanaAcceptanceCliOptions {
  const values = new Map<string, string>();
  let allowControlledMutation = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--allow-controlled-mutation') {
      if (allowControlledMutation) {
        throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
      }
      allowControlledMutation = true;
      continue;
    }
    if (flag === undefined || !valueFlags.has(flag) || values.has(flag)) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
    }
    values.set(flag, value);
    index += 1;
  }
  const credentialFile = values.get('--credential-file');
  const workspace = values.get('--workspace-gid');
  const project = values.get('--project-gid');
  const authorizationFile = values.get('--authorization-file');
  const assessmentMarker = values.get('--assessment-marker');
  if (
    credentialFile === undefined ||
    (project !== undefined && workspace === undefined) ||
    (allowControlledMutation &&
      (workspace === undefined ||
        project === undefined ||
        authorizationFile === undefined ||
        assessmentMarker === undefined)) ||
    (!allowControlledMutation &&
      (authorizationFile !== undefined || assessmentMarker !== undefined))
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_ARGUMENT_INVALID');
  }
  return {
    credentialFile,
    ...(workspace === undefined ? {} : { workspaceGid: gid(workspace) }),
    ...(project === undefined ? {} : { projectGid: gid(project) }),
    ...(values.get('--max-items') === undefined
      ? {}
      : { maxItems: positiveInteger(values.get('--max-items')!) }),
    ...(values.get('--max-pages') === undefined
      ? {}
      : { maxPages: positiveInteger(values.get('--max-pages')!) }),
    allowControlledMutation,
    ...(authorizationFile === undefined ? {} : { authorizationFile }),
    ...(assessmentMarker === undefined
      ? {}
      : { assessmentMarker: marker(assessmentMarker) }),
  };
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closing = trimmed.lastIndexOf(quote);
    if (closing === 0 || !/^\s*(?:#.*)?$/u.test(trimmed.slice(closing + 1))) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_CREDENTIAL_INVALID');
    }
    const content = trimmed.slice(1, closing);
    if (quote === "'") return content;
    return content.replace(/\\([\\"nrt])/gu, (_match, escaped: string) => {
      if (escaped === 'n') return '\n';
      if (escaped === 'r') return '\r';
      if (escaped === 't') return '\t';
      return escaped;
    });
  }
  const comment = trimmed.search(/\s#/u);
  return (comment < 0 ? trimmed : trimmed.slice(0, comment)).trim();
}

export function parseAsanaPatEnv(raw: string): string {
  if (
    Buffer.byteLength(raw, 'utf8') > ASANA_ACCEPTANCE_MAX_CREDENTIAL_FILE_BYTES
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_CREDENTIAL_INVALID');
  }
  let pat: string | undefined;
  for (const rawLine of raw.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/u.exec(
      line,
    );
    if (match === null) {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_CREDENTIAL_INVALID');
    }
    const key = match[1]!;
    const value = parseEnvValue(match[2]!);
    if (key === 'ASANA_PAT') {
      if (
        pat !== undefined ||
        value.length < 16 ||
        value.length > 4_096 ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 33 || code > 126;
        })
      ) {
        throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_CREDENTIAL_INVALID');
      }
      pat = value;
    }
  }
  if (pat === undefined) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_CREDENTIAL_INVALID');
  }
  return pat;
}

export class FileAsanaCredentialSource implements AsanaCredentialSource {
  public constructor(private readonly filePath: string) {}

  public async withBearerToken<T>(
    _account: Parameters<AsanaCredentialSource['withBearerToken']>[0],
    use: (token: string) => Promise<T>,
  ): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_CREDENTIAL_INVALID');
    }
    const token = parseAsanaPatEnv(raw);
    return use(token);
  }
}

function stringRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  return value as Readonly<Record<string, unknown>>;
}

export function parseControlledAuthorization(
  raw: string,
): AsanaControlledAuthorization {
  if (
    Buffer.byteLength(raw, 'utf8') >
    ASANA_ACCEPTANCE_MAX_AUTHORIZATION_FILE_BYTES
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  const record = stringRecord(value);
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    'assessmentMarker',
    'authorizationId',
    'authorizedOperations',
    'expiresAt',
    'kind',
    'projectGid',
    'schemaVersion',
    'workspaceGid',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  if (
    record.schemaVersion !== '1' ||
    record.kind !== 'asana_controlled_assessment_authorization' ||
    typeof record.authorizationId !== 'string' ||
    typeof record.workspaceGid !== 'string' ||
    typeof record.projectGid !== 'string' ||
    typeof record.assessmentMarker !== 'string' ||
    typeof record.expiresAt !== 'string' ||
    !Array.isArray(record.authorizedOperations) ||
    record.authorizedOperations.length !== 2 ||
    record.authorizedOperations[0] !== 'create_task' ||
    record.authorizedOperations[1] !== 'update_task'
  ) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  return {
    schemaVersion: '1',
    kind: 'asana_controlled_assessment_authorization',
    authorizationId: record.authorizationId,
    workspaceGid: record.workspaceGid,
    projectGid: record.projectGid,
    assessmentMarker: record.assessmentMarker,
    authorizedOperations: ['create_task', 'update_task'],
    expiresAt: record.expiresAt,
  };
}

async function loadAuthorization(
  options: AsanaAcceptanceCliOptions,
  readText: (path: string) => Promise<string> = (path) =>
    readFile(path, 'utf8'),
): Promise<AsanaControlledAuthorization | undefined> {
  if (
    !options.allowControlledMutation ||
    options.authorizationFile === undefined
  )
    return undefined;
  let raw: string;
  try {
    raw = await readText(options.authorizationFile);
  } catch {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_INVALID');
  }
  const authorization = parseControlledAuthorization(raw);
  if (authorization.assessmentMarker !== options.assessmentMarker) {
    throw new AsanaAcceptanceError('ASANA_ACCEPTANCE_AUTHORIZATION_MISMATCH');
  }
  return authorization;
}

export interface AsanaAcceptanceCliDependencies {
  readonly now?: () => string;
  readonly readAuthorizationFile?: (path: string) => Promise<string>;
  readonly createTransport?: (
    credentialFile: string,
    evidence: AsanaTransportEvidence[],
  ) => AsanaTransport;
  readonly runAcceptance?: typeof runAsanaAcceptance;
  readonly writeOutput?: (value: string) => void;
}

function failureEvidence(code: AsanaAcceptanceIssueCode, observedAt: string) {
  return {
    schemaVersion: '1',
    mode: 'asana_acceptance',
    status: 'fail',
    issueCodes: [code],
    observedAt,
  } as const;
}

export async function runAsanaAcceptanceCli(
  argv: readonly string[],
  dependencies: AsanaAcceptanceCliDependencies = {},
): Promise<number> {
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const writeOutput =
    dependencies.writeOutput ??
    ((value: string) => process.stdout.write(value));
  try {
    const options = parseAsanaAcceptanceCli(argv);
    const authorization = await loadAuthorization(
      options,
      dependencies.readAuthorizationFile,
    );
    if (authorization !== undefined) {
      validateControlledAuthorization(
        authorization,
        options.workspaceGid!,
        options.projectGid!,
        observedAt,
      );
    }
    const evidence: AsanaTransportEvidence[] = [];
    const transport =
      dependencies.createTransport?.(options.credentialFile, evidence) ??
      new AsanaRestTransport({
        credentials: new FileAsanaCredentialSource(options.credentialFile),
        evidence: { record: (item) => evidence.push(item) },
      });
    const report = await (dependencies.runAcceptance ?? runAsanaAcceptance)({
      transport,
      transportEvidence: evidence,
      ...(options.workspaceGid === undefined
        ? {}
        : { workspaceGid: options.workspaceGid }),
      ...(options.projectGid === undefined
        ? {}
        : { projectGid: options.projectGid }),
      ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      ...(authorization === undefined
        ? {}
        : { mutationAuthorization: authorization }),
    });
    writeOutput(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    writeOutput(
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
  process.exitCode = await runAsanaAcceptanceCli(process.argv.slice(2));
}

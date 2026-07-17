import { createHash } from 'node:crypto';

import {
  accountIdSchema,
  connectorSnapshotSchema,
  pollRequestSchema,
  tenantIdSchema,
} from '@chief/contracts';
import type {
  CanonicalEnvelope,
  ConnectorAccountRef,
  ConnectorSnapshot,
  PollRequest,
} from '@chief/contracts/connectors';
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';

import { backfillGmailMessages } from './backfill.js';
import { createGoogleApisGmailConnector } from './composition.js';
import { GmailHistoryResetRequiredError } from './connector.js';
import {
  gmailConnectorDescriptor,
  GMAIL_AUTHORIZATION_AUDIENCE,
  GMAIL_CONNECTOR_ID,
  GMAIL_DESCRIPTOR_VERSION,
  GMAIL_OAUTH_SCOPES,
} from './descriptor.js';
import type {
  GmailApiEvidenceBoundary,
  GmailPreparedMimeSource,
} from './googleapis-client.js';
import type { GmailCursorCodec } from './types.js';

export const GMAIL_ACCEPTANCE_DEFAULT_MAX_ITEMS = 5;
export const GMAIL_ACCEPTANCE_DEFAULT_MAX_PAGES = 2;
export const GMAIL_ACCEPTANCE_HARD_MAX_ITEMS = 25;
export const GMAIL_ACCEPTANCE_HARD_MAX_PAGES = 3;
export const GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS = 15_000;
export const GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS = 10_000;
export const GMAIL_ACCEPTANCE_OVERALL_TIMEOUT_MILLISECONDS = 60_000;
export const GMAIL_ACCEPTANCE_MAX_TOKEN_TRAIL = 12;
const TOKEN_EXPIRY_SAFETY_MILLISECONDS = 60_000;
const GOOGLE_REQUEST_OPTIONS = Object.freeze({
  retry: false,
  timeout: GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
});

export type GmailAcceptanceIssueCode =
  | 'GMAIL_ACCEPTANCE_ARGUMENT_INVALID'
  | 'GMAIL_ACCEPTANCE_BODY_OR_ATTACHMENT_LEAKAGE'
  | 'GMAIL_ACCEPTANCE_CHECKPOINT_ACCOUNT_MISMATCH'
  | 'GMAIL_ACCEPTANCE_CHECKPOINT_INVALID'
  | 'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID'
  | 'GMAIL_ACCEPTANCE_EXPECTED_ACCOUNT_INVALID'
  | 'GMAIL_ACCEPTANCE_HISTORY_RESET'
  | 'GMAIL_ACCEPTANCE_MESSAGE_ID_MISMATCH'
  | 'GMAIL_ACCEPTANCE_MESSAGE_THREAD_MISMATCH'
  | 'GMAIL_ACCEPTANCE_OAUTH_AUDIENCE_MISMATCH'
  | 'GMAIL_ACCEPTANCE_OAUTH_SCOPE_DRIFT'
  | 'GMAIL_ACCEPTANCE_PROFILE_INVALID'
  | 'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN'
  | 'GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID'
  | 'GMAIL_ACCEPTANCE_SEND_FORBIDDEN'
  | 'GMAIL_ACCEPTANCE_TOKEN_INVALID'
  | 'GMAIL_ACCEPTANCE_TOKEN_STALE'
  | 'GMAIL_ACCEPTANCE_TIMEOUT'
  | 'GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD'
  | 'GMAIL_ACCEPTANCE_UNEXPECTED_FAILURE'
  | 'GMAIL_ACCEPTANCE_WRONG_ACCOUNT';

export class GmailAcceptanceError extends Error {
  public constructor(public readonly code: GmailAcceptanceIssueCode) {
    super(code);
    this.name = 'GmailAcceptanceError';
  }
}

export interface GmailOAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly applicationType: 'installed' | 'web';
}

export interface GmailAcceptanceTokenInfo {
  readonly aud: string;
  readonly scopes: readonly string[];
  readonly expiryDate: number;
}

export interface GmailAcceptanceOAuthClient {
  setCredentials(credentials: { readonly refresh_token: string }): void;
  getAccessToken(): Promise<string | null | { readonly token?: string | null }>;
  getTokenInfo(accessToken: string): Promise<{
    readonly aud: string;
    readonly scopes: readonly string[];
    readonly expiry_date: number;
  }>;
}

export interface GmailAcceptanceGoogleApisSurface {
  createOAuth2Client(
    credentials: GmailOAuthClientCredentials,
  ): GmailAcceptanceOAuthClient;
  createGmailClient(auth: GmailAcceptanceOAuthClient): gmail_v1.Gmail;
}

export const googleApisAcceptanceSurface: GmailAcceptanceGoogleApisSurface = {
  createOAuth2Client: (credentials) =>
    new google.auth.OAuth2(
      credentials.clientId,
      credentials.clientSecret,
      credentials.redirectUri,
    ),
  createGmailClient: (auth) =>
    google.gmail({ version: 'v1', auth: auth as never }),
};

export interface GmailAcceptanceCheckpoint {
  readonly schemaVersion: '1';
  readonly mode: 'read_only_acceptance';
  readonly accountIdentityHash: string;
  readonly capabilitySnapshotHash: string;
  readonly historyCursor: string;
  readonly historyWatermarkHash: string;
  readonly checkpointEpoch: number;
  readonly historyPageTokenHashes: readonly string[];
  readonly backfillPageTokenHashes: readonly string[];
  readonly backfillFence?: string;
  readonly backfillPageToken?: string;
  readonly backfillComplete: boolean;
  readonly updatedAt: string;
  readonly checkpointIdentityHash: string;
}

export interface GmailAcceptanceApiCallCounts {
  readonly profile: number;
  readonly historyList: number;
  readonly messageList: number;
  readonly messageGet: number;
  readonly unexpected: number;
  readonly mutations: number;
}

export interface GmailAcceptanceReport {
  readonly schemaVersion: '1';
  readonly mode: 'read_only_acceptance';
  readonly status: 'pass';
  readonly issueCodes: readonly GmailAcceptanceIssueCode[];
  readonly observedAt: string;
  readonly capability: {
    readonly audience: typeof GMAIL_AUTHORIZATION_AUDIENCE;
    readonly scopes: readonly string[];
    readonly read: true;
    readonly poll: true;
    readonly historicalBackfill: true;
    readonly externalMutations: false;
  };
  readonly account: {
    readonly identityHash: string;
    readonly oauthClientAudienceHash: string;
  };
  readonly bounds: {
    readonly maxItems: number;
    readonly maxPages: number;
    readonly hardMaxItems: typeof GMAIL_ACCEPTANCE_HARD_MAX_ITEMS;
    readonly hardMaxPages: typeof GMAIL_ACCEPTANCE_HARD_MAX_PAGES;
  };
  readonly transportPolicy: {
    readonly retries: false;
    readonly oauthTimeoutMilliseconds: typeof GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS;
    readonly apiCallTimeoutMilliseconds: typeof GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS;
    readonly overallTimeoutMilliseconds: typeof GMAIL_ACCEPTANCE_OVERALL_TIMEOUT_MILLISECONDS;
  };
  readonly profile: {
    readonly messageCount: number;
    readonly threadCount: number;
    readonly historyWatermarkHash: string;
  };
  readonly observed: {
    readonly historyEnvelopeCount: number;
    readonly backfillEnvelopeCount: number;
    readonly normalizedEnvelopeCount: number;
    readonly capturedMessageCount: number;
    readonly attachmentMetadataCount: number;
    readonly earliestSourceTimestamp?: string;
    readonly latestSourceTimestamp?: string;
    readonly apiCalls: GmailAcceptanceApiCallCounts;
  };
  readonly evidence: {
    readonly normalizedSetHash: string;
    readonly providerResponseSetHash: string;
    readonly checkpointIdentityHash: string;
  };
  readonly checkpoint: {
    readonly resumed: boolean;
    readonly backfillComplete: boolean;
    readonly identityHash: string;
  };
}

export interface GmailAcceptanceRunResult {
  readonly report: GmailAcceptanceReport;
  readonly checkpoint: GmailAcceptanceCheckpoint;
}

export interface GmailAcceptanceRunInput {
  readonly oauthClient: GmailOAuthClientCredentials;
  readonly refreshToken: string;
  readonly expectedAccount: string;
  readonly checkpoint?: GmailAcceptanceCheckpoint;
  readonly maxItems?: number;
  readonly maxPages?: number;
  readonly now?: () => string;
  readonly googleApis?: GmailAcceptanceGoogleApisSurface;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function canonicalJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, candidate]) => [key, canonicalJsonValue(candidate)]),
    );
  }
  throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_UNEXPECTED_FAILURE');
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)), 'utf8')
    .digest('hex');
}

function requireNonEmpty(
  value: string,
  code: GmailAcceptanceIssueCode,
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new GmailAcceptanceError(code);
  }
  return normalized;
}

function sameExactSet(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left]
      .sort()
      .every((candidate, index) => candidate === [...right].sort()[index])
  );
}

function accessTokenValue(
  result: Awaited<ReturnType<GmailAcceptanceOAuthClient['getAccessToken']>>,
): string | undefined {
  if (typeof result === 'string') return result;
  return result?.token ?? undefined;
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMilliseconds: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new GmailAcceptanceError('GMAIL_ACCEPTANCE_TIMEOUT'));
          onTimeout?.();
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function integerCount(value: number | null | undefined): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_PROFILE_INVALID');
  }
  return value;
}

function encodeCursor(cursor: {
  readonly historyId: string;
  readonly pageToken?: string;
  readonly latestHistoryId?: string;
}): string {
  return `gmail-acceptance:v1:${Buffer.from(
    JSON.stringify(cursor),
    'utf8',
  ).toString('base64url')}`;
}

function decodeCursor(value: string): {
  readonly historyId: string;
  readonly pageToken?: string;
  readonly latestHistoryId?: string;
} {
  const prefix = 'gmail-acceptance:v1:';
  if (!value.startsWith(prefix)) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
  try {
    const encoded = value.slice(prefix.length);
    if (
      !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
      Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
    ) {
      throw new Error('invalid');
    }
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('invalid');
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    const expectedKeys = [
      'historyId',
      ...(record.pageToken === undefined ? [] : ['pageToken']),
      ...(record.latestHistoryId === undefined ? [] : ['latestHistoryId']),
    ].sort();
    if (
      !sameExactSet(keys, expectedKeys) ||
      typeof record.historyId !== 'string' ||
      record.historyId.trim().length === 0 ||
      (record.pageToken !== undefined &&
        (typeof record.pageToken !== 'string' ||
          record.pageToken.trim().length === 0)) ||
      (record.latestHistoryId !== undefined &&
        (typeof record.latestHistoryId !== 'string' ||
          record.latestHistoryId.trim().length === 0)) ||
      (record.pageToken === undefined) !==
        (record.latestHistoryId === undefined)
    ) {
      throw new Error('invalid');
    }
    return {
      historyId: record.historyId,
      ...(record.pageToken === undefined
        ? {}
        : { pageToken: record.pageToken }),
      ...(record.latestHistoryId === undefined
        ? {}
        : { latestHistoryId: record.latestHistoryId }),
    };
  } catch {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
}

const acceptanceCursorCodec: GmailCursorCodec = {
  decodeHistoryCursor: (request) =>
    decodeCursor(request.checkpoint.encryptedCursor),
  encodeHistoryCursor: encodeCursor,
};

class AcceptanceEvidenceBoundary implements GmailApiEvidenceBoundary {
  public readonly capturedHashes: string[] = [];
  public readonly providerResponseHashes: string[] = [];
  readonly #contentSentinels = new Set<string>();

  #rememberContent(value: unknown, key?: string): void {
    if (typeof value === 'string') {
      if (value.length >= 8) this.#contentSentinels.add(value);
      if (key === 'data' && value.length > 0) {
        const decoded = Buffer.from(value, 'base64url').toString('utf8');
        if (decoded.length >= 8) this.#contentSentinels.add(decoded);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((candidate) => this.#rememberContent(candidate));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    Object.entries(value).forEach(([nestedKey, candidate]) =>
      this.#rememberContent(candidate, nestedKey),
    );
  }

  public captureMessage(
    _account: ConnectorAccountRef,
    message: gmail_v1.Schema$Message,
  ) {
    this.#rememberContent(message);
    const hash = stableHash(message);
    this.capturedHashes.push(hash);
    return Promise.resolve({
      rawBodyRef: `acceptance-capture://${hash}`,
      canonicalPayloadHash: hash,
    });
  }

  public hashProviderResponse(response: unknown): string {
    const hash = stableHash(response);
    this.providerResponseHashes.push(hash);
    return hash;
  }

  public assertNoContentLeak(
    evidence: unknown,
    additionalSentinels: readonly string[],
  ): void {
    const serialized = JSON.stringify(evidence);
    for (const sentinel of [
      ...this.#contentSentinels,
      ...additionalSentinels.filter((value) => value.length >= 8),
    ]) {
      if (serialized.includes(sentinel)) {
        throw new GmailAcceptanceError(
          'GMAIL_ACCEPTANCE_BODY_OR_ATTACHMENT_LEAKAGE',
        );
      }
    }
  }
}

function forbiddenSurface(
  method: string,
  counts: { unexpected: number; mutations: number },
): unknown {
  const callable = () => {
    counts.unexpected += 1;
    if (/send|watch|modify|delete|trash|untrash|stop/iu.test(method)) {
      counts.mutations += 1;
    }
    throw new GmailAcceptanceError(
      /send/iu.test(method)
        ? 'GMAIL_ACCEPTANCE_SEND_FORBIDDEN'
        : 'GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD',
    );
  };
  return new Proxy(callable, {
    get: (_target, property) =>
      forbiddenSurface(`${method}.${String(property)}`, counts),
  });
}

export function createReadOnlyAcceptanceGmailGuard(
  client: gmail_v1.Gmail,
  bounds: { readonly maxItems: number; readonly maxPages: number },
  initialTokenHashes: {
    readonly history?: readonly string[];
    readonly backfill?: readonly string[];
  } = {},
  overallSignal?: AbortSignal,
): {
  readonly gmail: gmail_v1.Gmail;
  readonly counts: GmailAcceptanceApiCallCounts;
  readonly tokenHashes: {
    readonly history: string[];
    readonly backfill: string[];
  };
} {
  const counts = {
    profile: 0,
    historyList: 0,
    messageList: 0,
    messageGet: 0,
    unexpected: 0,
    mutations: 0,
  };
  const tokenHashes = {
    history: [...(initialTokenHashes.history ?? [])],
    backfill: [...(initialTokenHashes.backfill ?? [])],
  };
  const requestOptions = {
    ...GOOGLE_REQUEST_OPTIONS,
    ...(overallSignal === undefined ? {} : { signal: overallSignal }),
  };
  const assertPaginationProgress = (
    stream: keyof typeof tokenHashes,
    inputToken: string | null | undefined,
    nextToken: string | null | undefined,
  ) => {
    if (nextToken === undefined || nextToken === null) return;
    const normalizedNext = nextToken.trim();
    if (normalizedNext.length === 0) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    const nextHash = stableHash(normalizedNext);
    if (
      nextToken === inputToken ||
      tokenHashes[stream].includes(nextHash) ||
      tokenHashes[stream].length >= GMAIL_ACCEPTANCE_MAX_TOKEN_TRAIL
    ) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    tokenHashes[stream].push(nextHash);
  };
  const assertUser = (userId: string | undefined) => {
    if (userId !== 'me') {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD');
    }
  };
  const profile = async (params: gmail_v1.Params$Resource$Users$Getprofile) => {
    assertUser(params.userId);
    counts.profile += 1;
    if (counts.profile > 1) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    return withDeadline(
      () => client.users.getProfile(params, requestOptions),
      GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
    );
  };
  const historyList = async (
    params: gmail_v1.Params$Resource$Users$History$List,
  ) => {
    assertUser(params.userId);
    counts.historyList += 1;
    if (
      counts.historyList > bounds.maxPages ||
      params.maxResults === undefined ||
      params.maxResults < 1 ||
      params.maxResults > bounds.maxItems ||
      params.historyTypes?.join('\u0000') !== 'messageAdded'
    ) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    const response = await withDeadline(
      () => client.users.history.list(params, requestOptions),
      GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
    );
    const history = response.data.history ?? [];
    const messageReferences = history.reduce(
      (total, record) => total + (record.messagesAdded?.length ?? 0),
      0,
    );
    if (
      history.length > params.maxResults ||
      messageReferences > params.maxResults
    ) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    assertPaginationProgress(
      'history',
      params.pageToken,
      response.data.nextPageToken,
    );
    return response;
  };
  const messageList = async (
    params: gmail_v1.Params$Resource$Users$Messages$List,
  ) => {
    assertUser(params.userId);
    counts.messageList += 1;
    if (
      counts.messageList > bounds.maxPages ||
      params.maxResults === undefined ||
      params.maxResults < 1 ||
      params.maxResults > bounds.maxItems ||
      params.includeSpamTrash !== true ||
      params.q !== undefined
    ) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    const response = await withDeadline(
      () => client.users.messages.list(params, requestOptions),
      GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
    );
    if ((response.data.messages?.length ?? 0) > params.maxResults) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    assertPaginationProgress(
      'backfill',
      params.pageToken,
      response.data.nextPageToken,
    );
    return response;
  };
  const messageGet = async (
    params: gmail_v1.Params$Resource$Users$Messages$Get,
  ) => {
    assertUser(params.userId);
    counts.messageGet += 1;
    if (
      counts.messageGet > bounds.maxItems * 2 ||
      params.format !== 'full' ||
      params.metadataHeaders !== undefined
    ) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      );
    }
    return withDeadline(
      () => client.users.messages.get(params, requestOptions),
      GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
    );
  };
  const messages = new Proxy(
    { list: messageList, get: messageGet },
    {
      get: (target, property) =>
        property === 'list'
          ? target.list
          : property === 'get'
            ? target.get
            : forbiddenSurface(`users.messages.${String(property)}`, counts),
    },
  );
  const history = new Proxy(
    { list: historyList },
    {
      get: (target, property) =>
        property === 'list'
          ? target.list
          : forbiddenSurface(`users.history.${String(property)}`, counts),
    },
  );
  const users = new Proxy(
    { getProfile: profile, history, messages },
    {
      get: (target, property) =>
        property === 'getProfile'
          ? target.getProfile
          : property === 'history'
            ? target.history
            : property === 'messages'
              ? target.messages
              : forbiddenSurface(`users.${String(property)}`, counts),
    },
  );
  return {
    gmail: { users } as unknown as gmail_v1.Gmail,
    counts,
    tokenHashes,
  };
}

function assertBounds(maxItems: number, maxPages: number): void {
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > GMAIL_ACCEPTANCE_HARD_MAX_ITEMS ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > GMAIL_ACCEPTANCE_HARD_MAX_PAGES
  ) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
  }
}

function assertCheckpoint(
  checkpoint: GmailAcceptanceCheckpoint,
  accountIdentityHash: string,
  capabilitySnapshotHash: string,
): void {
  const requiredKeys = [
    'schemaVersion',
    'mode',
    'accountIdentityHash',
    'capabilitySnapshotHash',
    'historyCursor',
    'historyWatermarkHash',
    'checkpointEpoch',
    'historyPageTokenHashes',
    'backfillPageTokenHashes',
    'backfillComplete',
    'updatedAt',
    'checkpointIdentityHash',
  ];
  const expectedKeys = [
    ...requiredKeys,
    ...(checkpoint.backfillFence === undefined ? [] : ['backfillFence']),
    ...(checkpoint.backfillPageToken === undefined
      ? []
      : ['backfillPageToken']),
  ];
  if (
    !sameExactSet(Object.keys(checkpoint), expectedKeys) ||
    checkpoint.schemaVersion !== '1' ||
    checkpoint.mode !== 'read_only_acceptance' ||
    typeof checkpoint.accountIdentityHash !== 'string' ||
    typeof checkpoint.capabilitySnapshotHash !== 'string' ||
    typeof checkpoint.historyCursor !== 'string' ||
    typeof checkpoint.historyWatermarkHash !== 'string' ||
    !Array.isArray(checkpoint.historyPageTokenHashes) ||
    !Array.isArray(checkpoint.backfillPageTokenHashes) ||
    typeof checkpoint.backfillComplete !== 'boolean' ||
    typeof checkpoint.updatedAt !== 'string' ||
    typeof checkpoint.checkpointIdentityHash !== 'string' ||
    checkpoint.checkpointEpoch < 1 ||
    !Number.isSafeInteger(checkpoint.checkpointEpoch) ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.accountIdentityHash) ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.capabilitySnapshotHash) ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.historyWatermarkHash) ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.checkpointIdentityHash) ||
    checkpoint.historyPageTokenHashes.length >
      GMAIL_ACCEPTANCE_MAX_TOKEN_TRAIL ||
    checkpoint.backfillPageTokenHashes.length >
      GMAIL_ACCEPTANCE_MAX_TOKEN_TRAIL ||
    checkpoint.historyPageTokenHashes.some(
      (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash),
    ) ||
    checkpoint.backfillPageTokenHashes.some(
      (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash),
    ) ||
    new Set(checkpoint.historyPageTokenHashes).size !==
      checkpoint.historyPageTokenHashes.length ||
    new Set(checkpoint.backfillPageTokenHashes).size !==
      checkpoint.backfillPageTokenHashes.length ||
    !Number.isFinite(Date.parse(checkpoint.updatedAt)) ||
    (checkpoint.backfillComplete &&
      (checkpoint.backfillFence !== undefined ||
        checkpoint.backfillPageToken !== undefined)) ||
    (!checkpoint.backfillComplete &&
      (checkpoint.backfillFence === undefined ||
        checkpoint.backfillFence.length === 0 ||
        checkpoint.backfillPageToken === undefined ||
        checkpoint.backfillPageToken.length === 0))
  ) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
  const continuation = {
    schemaVersion: checkpoint.schemaVersion,
    mode: checkpoint.mode,
    accountIdentityHash: checkpoint.accountIdentityHash,
    capabilitySnapshotHash: checkpoint.capabilitySnapshotHash,
    historyCursor: checkpoint.historyCursor,
    historyWatermarkHash: checkpoint.historyWatermarkHash,
    checkpointEpoch: checkpoint.checkpointEpoch,
    historyPageTokenHashes: checkpoint.historyPageTokenHashes,
    backfillPageTokenHashes: checkpoint.backfillPageTokenHashes,
    ...(checkpoint.backfillFence === undefined
      ? {}
      : { backfillFence: checkpoint.backfillFence }),
    ...(checkpoint.backfillPageToken === undefined
      ? {}
      : { backfillPageToken: checkpoint.backfillPageToken }),
    backfillComplete: checkpoint.backfillComplete,
    updatedAt: checkpoint.updatedAt,
  };
  if (checkpoint.checkpointIdentityHash !== stableHash(continuation)) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
  const cursor = decodeCursor(checkpoint.historyCursor);
  if (
    checkpoint.historyWatermarkHash !==
      stableHash(cursor.latestHistoryId ?? cursor.historyId) ||
    (cursor.pageToken === undefined
      ? checkpoint.historyPageTokenHashes.length !== 0
      : checkpoint.historyPageTokenHashes.at(-1) !==
        stableHash(cursor.pageToken)) ||
    (checkpoint.backfillComplete
      ? checkpoint.backfillPageTokenHashes.length !== 0
      : checkpoint.backfillPageTokenHashes.at(-1) !==
        stableHash(checkpoint.backfillPageToken ?? ''))
  ) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
  if (checkpoint.accountIdentityHash !== accountIdentityHash) {
    throw new GmailAcceptanceError(
      'GMAIL_ACCEPTANCE_CHECKPOINT_ACCOUNT_MISMATCH',
    );
  }
  if (checkpoint.capabilitySnapshotHash !== capabilitySnapshotHash) {
    throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_CHECKPOINT_INVALID');
  }
}

const forbiddenEvidenceKeys = new Set([
  'accessToken',
  'attachmentId',
  'body',
  'cc',
  'clientSecret',
  'emailAddress',
  'from',
  'htmlBody',
  'idToken',
  'messageId',
  'password',
  'payload',
  'providerMessageId',
  'providerThreadId',
  'rawBody',
  'rawBodyRef',
  'recipient',
  'refreshToken',
  'sender',
  'subject',
  'textBody',
  'threadId',
  'to',
]);

export function assertContentSafeAcceptanceEvidence(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbiddenEvidenceKeys.has(key)) {
        throw new GmailAcceptanceError(
          'GMAIL_ACCEPTANCE_BODY_OR_ATTACHMENT_LEAKAGE',
        );
      }
      visit(nested);
    }
  };
  visit(value);
}

function envelopeEvidence(envelopes: readonly CanonicalEnvelope[]) {
  return envelopes
    .map((envelope) => ({
      providerRefHash: stableHash(envelope.providerMessageRef),
      sourceTimestamp: envelope.sourceTimestamp,
      canonicalPayloadHash: envelope.canonicalPayloadHash,
      attachmentCount: envelope.attachmentCount,
    }))
    .sort((left, right) =>
      left.providerRefHash.localeCompare(right.providerRefHash),
    );
}

function mapKnownError(error: unknown): GmailAcceptanceError {
  if (error instanceof GmailAcceptanceError) return error;
  if (error instanceof GmailHistoryResetRequiredError) {
    return new GmailAcceptanceError('GMAIL_ACCEPTANCE_HISTORY_RESET');
  }
  if (error instanceof Error) {
    if (error.message === 'GMAIL_HISTORY_RESET_REQUIRED') {
      return new GmailAcceptanceError('GMAIL_ACCEPTANCE_HISTORY_RESET');
    }
    if (
      error.message === 'GMAIL_PROVIDER_MESSAGE_ID_MISMATCH' ||
      error.message === 'GMAIL_HISTORY_MESSAGE_ID_MISMATCH' ||
      error.message === 'GMAIL_BACKFILL_MESSAGE_ID_MISMATCH' ||
      error.message === 'GMAIL_MESSAGE_ID_MISMATCH'
    ) {
      return new GmailAcceptanceError('GMAIL_ACCEPTANCE_MESSAGE_ID_MISMATCH');
    }
    if (
      error.message === 'GMAIL_HISTORY_MESSAGE_THREAD_MISMATCH' ||
      error.message === 'GMAIL_BACKFILL_MESSAGE_THREAD_MISMATCH'
    ) {
      return new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_MESSAGE_THREAD_MISMATCH',
      );
    }
  }
  return new GmailAcceptanceError('GMAIL_ACCEPTANCE_UNEXPECTED_FAILURE');
}

export function acceptanceIssueCode(error: unknown): GmailAcceptanceIssueCode {
  return mapKnownError(error).code;
}

async function runGmailReadOnlyAcceptanceWithinDeadline(
  input: GmailAcceptanceRunInput,
  overallSignal: AbortSignal,
): Promise<GmailAcceptanceRunResult> {
  try {
    const now = input.now ?? (() => new Date().toISOString());
    const observedAt = now();
    const nowMilliseconds = Date.parse(observedAt);
    if (!Number.isFinite(nowMilliseconds)) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_ARGUMENT_INVALID');
    }
    const maxItems = input.maxItems ?? GMAIL_ACCEPTANCE_DEFAULT_MAX_ITEMS;
    const maxPages = input.maxPages ?? GMAIL_ACCEPTANCE_DEFAULT_MAX_PAGES;
    assertBounds(maxItems, maxPages);
    const refreshToken = requireNonEmpty(
      input.refreshToken,
      'GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID',
    );
    const expectedAccount = requireNonEmpty(
      input.expectedAccount,
      'GMAIL_ACCEPTANCE_EXPECTED_ACCOUNT_INVALID',
    ).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/u.test(expectedAccount)) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_EXPECTED_ACCOUNT_INVALID',
      );
    }
    const clientId = requireNonEmpty(
      input.oauthClient.clientId,
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
    requireNonEmpty(
      input.oauthClient.clientSecret,
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
    requireNonEmpty(
      input.oauthClient.redirectUri,
      'GMAIL_ACCEPTANCE_CLIENT_CREDENTIALS_INVALID',
    );
    const descriptor = gmailConnectorDescriptor();
    if (descriptor.authorizationAudience !== GMAIL_AUTHORIZATION_AUDIENCE) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_OAUTH_AUDIENCE_MISMATCH',
      );
    }
    if (!sameExactSet(descriptor.authorizationScopes, GMAIL_OAUTH_SCOPES)) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_OAUTH_SCOPE_DRIFT');
    }
    const accountIdentityHash = stableHash(expectedAccount);
    const capabilitySnapshotHash = stableHash(descriptor);
    if (input.checkpoint !== undefined) {
      assertCheckpoint(
        input.checkpoint,
        accountIdentityHash,
        capabilitySnapshotHash,
      );
    }

    const surface = input.googleApis ?? googleApisAcceptanceSurface;
    const auth = surface.createOAuth2Client(input.oauthClient);
    auth.setCredentials({ refresh_token: refreshToken });
    let accessToken: string;
    let tokenInfo: GmailAcceptanceTokenInfo;
    try {
      const tokenResult = await withDeadline(
        () => auth.getAccessToken(),
        GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS,
      );
      accessToken = requireNonEmpty(
        accessTokenValue(tokenResult) ?? '',
        'GMAIL_ACCEPTANCE_TOKEN_INVALID',
      );
      const rawInfo = await withDeadline(
        () => auth.getTokenInfo(accessToken),
        GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS,
      );
      tokenInfo = {
        aud: rawInfo.aud,
        scopes: rawInfo.scopes,
        expiryDate: rawInfo.expiry_date,
      };
    } catch (error) {
      if (error instanceof GmailAcceptanceError) throw error;
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_TOKEN_INVALID');
    }
    if (tokenInfo.aud !== clientId) {
      throw new GmailAcceptanceError(
        'GMAIL_ACCEPTANCE_OAUTH_AUDIENCE_MISMATCH',
      );
    }
    if (!sameExactSet(tokenInfo.scopes, GMAIL_OAUTH_SCOPES)) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_OAUTH_SCOPE_DRIFT');
    }
    if (
      !Number.isFinite(tokenInfo.expiryDate) ||
      tokenInfo.expiryDate <= nowMilliseconds + TOKEN_EXPIRY_SAFETY_MILLISECONDS
    ) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_TOKEN_STALE');
    }

    const guarded = createReadOnlyAcceptanceGmailGuard(
      surface.createGmailClient(auth),
      { maxItems, maxPages },
      {
        history: input.checkpoint?.historyPageTokenHashes,
        backfill: input.checkpoint?.backfillPageTokenHashes,
      },
      overallSignal,
    );
    const profileResponse = await guarded.gmail.users.getProfile({
      userId: 'me',
    });
    const profileIdentity = requireNonEmpty(
      profileResponse.data.emailAddress ?? '',
      'GMAIL_ACCEPTANCE_PROFILE_INVALID',
    ).toLowerCase();
    if (profileIdentity !== expectedAccount) {
      throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_WRONG_ACCOUNT');
    }
    const profileHistoryId = requireNonEmpty(
      profileResponse.data.historyId ?? '',
      'GMAIL_ACCEPTANCE_PROFILE_INVALID',
    );
    const accountId = accountIdSchema.parse(
      `gmail-acceptance-${accountIdentityHash.slice(0, 24)}`,
    );
    const account: ConnectorAccountRef = {
      tenantId: tenantIdSchema.parse('gmail-read-only-acceptance'),
      accountId,
      expectedStateVersion: 1,
    };
    const snapshot: ConnectorSnapshot = connectorSnapshotSchema.parse({
      connectorId: GMAIL_CONNECTOR_ID,
      descriptorVersion: GMAIL_DESCRIPTOR_VERSION,
      accountId,
      capabilitySnapshotHash,
      runtimeMode: 'live',
      selectionState: 'selected',
    });
    const evidence = new AcceptanceEvidenceBoundary();
    const forbiddenPreparedMime: GmailPreparedMimeSource = {
      load: () => {
        throw new GmailAcceptanceError('GMAIL_ACCEPTANCE_SEND_FORBIDDEN');
      },
    };
    const composition = createGoogleApisGmailConnector({
      gmail: guarded.gmail,
      evidence,
      preparedMime: forbiddenPreparedMime,
      snapshots: { snapshotForAccount: () => snapshot },
      oauth: {
        completeAuthorization: () => {
          throw new GmailAcceptanceError(
            'GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD',
          );
        },
      },
      cursorCodec: acceptanceCursorCodec,
      oauthClientId: clientId,
      now,
    });

    const scopeHash = stableHash({
      mode: 'read_only_acceptance',
      accountIdentityHash,
      scopes: [...GMAIL_OAUTH_SCOPES].sort(),
    });
    const historyCursor =
      input.checkpoint?.historyCursor ??
      encodeCursor({ historyId: profileHistoryId });
    const checkpointEpoch = input.checkpoint?.checkpointEpoch ?? 1;
    const pollRequest: PollRequest = pollRequestSchema.parse({
      schemaVersion: '1',
      account,
      resourceScopeHash: scopeHash,
      checkpoint: {
        schemaVersion: '1',
        tenantId: account.tenantId,
        accountId,
        resourceScopeHash: scopeHash,
        kind: 'history',
        encryptedCursor: historyCursor,
        checkpointEpoch,
        adapterVersion: GMAIL_DESCRIPTOR_VERSION,
        sourceWatermark: profileHistoryId,
        lastCompletePage: 0,
        status: 'active',
        committedAt: observedAt,
      },
      expectedCheckpointEpoch: checkpointEpoch,
      adapterVersion: GMAIL_DESCRIPTOR_VERSION,
      maxItems,
      maxPages,
    });
    const history = await composition.connector.poll(account, pollRequest);

    const pendingBackfill =
      input.checkpoint === undefined || !input.checkpoint.backfillComplete;
    const backfill = pendingBackfill
      ? await backfillGmailMessages(composition.client, {
          account,
          connectorSnapshot: snapshot,
          maxItems,
          maxPages,
          ...(input.checkpoint?.backfillFence === undefined
            ? { fencedHistoryId: profileHistoryId }
            : { fencedHistoryId: input.checkpoint.backfillFence }),
          ...(input.checkpoint?.backfillPageToken === undefined
            ? {}
            : { pageToken: input.checkpoint.backfillPageToken }),
        })
      : undefined;
    const backfillEnvelopes = backfill?.envelopes ?? [];
    const envelopes = [...history.envelopes, ...backfillEnvelopes];
    const safeEnvelopes = envelopeEvidence(envelopes);
    const sourceTimestamps = safeEnvelopes
      .map(({ sourceTimestamp }) => sourceTimestamp)
      .sort();
    const nextHistoryCursor = history.nextEncryptedCursor ?? historyCursor;
    const nextDecodedCursor = decodeCursor(nextHistoryCursor);
    const nextCheckpointContinuation = {
      schemaVersion: '1',
      mode: 'read_only_acceptance',
      accountIdentityHash,
      capabilitySnapshotHash,
      historyCursor: nextHistoryCursor,
      historyWatermarkHash: stableHash(history.sourceWatermark),
      checkpointEpoch: checkpointEpoch + 1,
      historyPageTokenHashes:
        nextDecodedCursor.pageToken === undefined
          ? []
          : [...guarded.tokenHashes.history],
      backfillPageTokenHashes:
        backfill === undefined || backfill.complete
          ? []
          : [...guarded.tokenHashes.backfill],
      ...(backfill === undefined || backfill.complete
        ? {}
        : {
            backfillFence: backfill.fencedHistoryId,
            backfillPageToken: backfill.nextPageToken,
          }),
      backfillComplete: backfill?.complete ?? true,
      updatedAt: observedAt,
    } as const;
    const checkpointIdentityHash = stableHash(nextCheckpointContinuation);
    const nextCheckpoint: GmailAcceptanceCheckpoint = {
      ...nextCheckpointContinuation,
      checkpointIdentityHash,
    };
    const report: GmailAcceptanceReport = {
      schemaVersion: '1',
      mode: 'read_only_acceptance',
      status: 'pass',
      issueCodes: [],
      observedAt,
      capability: {
        audience: GMAIL_AUTHORIZATION_AUDIENCE,
        scopes: [...GMAIL_OAUTH_SCOPES],
        read: true,
        poll: true,
        historicalBackfill: true,
        externalMutations: false,
      },
      account: {
        identityHash: accountIdentityHash,
        oauthClientAudienceHash: stableHash(clientId),
      },
      bounds: {
        maxItems,
        maxPages,
        hardMaxItems: GMAIL_ACCEPTANCE_HARD_MAX_ITEMS,
        hardMaxPages: GMAIL_ACCEPTANCE_HARD_MAX_PAGES,
      },
      transportPolicy: {
        retries: false,
        oauthTimeoutMilliseconds: GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS,
        apiCallTimeoutMilliseconds: GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
        overallTimeoutMilliseconds:
          GMAIL_ACCEPTANCE_OVERALL_TIMEOUT_MILLISECONDS,
      },
      profile: {
        messageCount: integerCount(profileResponse.data.messagesTotal),
        threadCount: integerCount(profileResponse.data.threadsTotal),
        historyWatermarkHash: stableHash(profileHistoryId),
      },
      observed: {
        historyEnvelopeCount: history.envelopes.length,
        backfillEnvelopeCount: backfillEnvelopes.length,
        normalizedEnvelopeCount: envelopes.length,
        capturedMessageCount: evidence.capturedHashes.length,
        attachmentMetadataCount: envelopes.reduce(
          (total, envelope) => total + envelope.attachmentCount,
          0,
        ),
        ...(sourceTimestamps[0] === undefined
          ? {}
          : { earliestSourceTimestamp: sourceTimestamps[0] }),
        ...(sourceTimestamps.at(-1) === undefined
          ? {}
          : { latestSourceTimestamp: sourceTimestamps.at(-1) }),
        apiCalls: Object.freeze({ ...guarded.counts }),
      },
      evidence: {
        normalizedSetHash: stableHash(safeEnvelopes),
        providerResponseSetHash: stableHash(
          [...evidence.providerResponseHashes].sort(),
        ),
        checkpointIdentityHash,
      },
      checkpoint: {
        resumed: input.checkpoint !== undefined,
        backfillComplete: backfill?.complete ?? true,
        identityHash: checkpointIdentityHash,
      },
    };
    assertContentSafeAcceptanceEvidence(report);
    evidence.assertNoContentLeak(report, [
      refreshToken,
      accessToken,
      input.oauthClient.clientSecret,
      profileIdentity,
      expectedAccount,
    ]);
    if (
      guarded.counts.unexpected !== 0 ||
      guarded.counts.mutations !== 0 ||
      report.observed.normalizedEnvelopeCount > maxItems * 2
    ) {
      throw new GmailAcceptanceError(
        guarded.counts.mutations === 0
          ? 'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN'
          : 'GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD',
      );
    }
    return { report, checkpoint: nextCheckpoint };
  } catch (error) {
    throw mapKnownError(error);
  }
}

export async function runGmailReadOnlyAcceptance(
  input: GmailAcceptanceRunInput,
): Promise<GmailAcceptanceRunResult> {
  try {
    const overallController = new AbortController();
    return await withDeadline(
      () =>
        runGmailReadOnlyAcceptanceWithinDeadline(
          input,
          overallController.signal,
        ),
      GMAIL_ACCEPTANCE_OVERALL_TIMEOUT_MILLISECONDS,
      () => overallController.abort(),
    );
  } catch (error) {
    throw mapKnownError(error);
  }
}

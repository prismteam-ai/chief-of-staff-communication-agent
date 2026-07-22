import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';

import {
  acceptanceIssueCode,
  assertContentSafeAcceptanceEvidence,
  createReadOnlyAcceptanceGmailGuard,
  GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
  GMAIL_ACCEPTANCE_HARD_MAX_ITEMS,
  GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS,
  runGmailReadOnlyAcceptance,
  type GmailAcceptanceGoogleApisSurface,
  type GmailAcceptanceCheckpoint,
  type GmailAcceptanceOAuthClient,
  type GmailAcceptanceRunInput,
} from './acceptance.js';
import {
  gmailConnectorDescriptor,
  GMAIL_OAUTH_SCOPES,
  GMAIL_READ_ONLY_OAUTH_SCOPES,
} from './descriptor.js';
import * as descriptorModule from './descriptor.js';

const NOW = '2026-07-17T12:00:00.000Z';
const ACCOUNT = 'acceptance.person@example.invalid';
const CLIENT_ID = 'acceptance-client.apps.example.invalid';
const OPAQUE_REFRESH_FIXTURE = ['refresh', 'fixture', 'never', 'print'].join(
  '-',
);
const OPAQUE_ACCESS_FIXTURE = ['access', 'fixture', 'never', 'print'].join('-');
const OPAQUE_CLIENT_FIXTURE = ['client', 'fixture', 'never', 'print'].join('-');
const MESSAGE_ID = 'provider-message-never-print';
const THREAD_ID = 'provider-thread-never-print';
const BODY = 'body-never-print';
const SUBJECT = 'subject-never-print';

interface FakeOptions {
  readonly tokenAudience?: string;
  readonly scopes?: readonly string[];
  readonly expiryDate?: number;
  readonly profileAccount?: string;
  readonly historyError?: Error;
  readonly oversizedHistory?: boolean;
  readonly oversizedHistoryReferences?: boolean;
  readonly threadMismatch?: boolean;
  readonly messageIdSubstitution?: boolean;
  readonly emptyHistory?: boolean;
  readonly pagedBackfill?: boolean;
  readonly historyPagination?: 'stall' | 'cycle';
  readonly backfillPagination?: 'stall' | 'cycle';
  readonly stalledOAuth?: boolean;
  readonly stalledProfile?: boolean;
}

interface FakeCalls {
  readonly profile: gmail_v1.Params$Resource$Users$Getprofile[];
  readonly history: gmail_v1.Params$Resource$Users$History$List[];
  readonly messageList: gmail_v1.Params$Resource$Users$Messages$List[];
  readonly messageGet: gmail_v1.Params$Resource$Users$Messages$Get[];
  readonly requestOptions: unknown[];
  oauthClientCreate: number;
  gmailClientCreate: number;
  send: number;
  watch: number;
  modify: number;
  delete: number;
  attachmentGet: number;
}

function providerMessage(id = MESSAGE_ID, threadId = THREAD_ID) {
  return {
    id,
    threadId,
    historyId: '101',
    internalDate: String(Date.parse('2026-07-17T11:58:00.000Z')),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'sender@example.invalid' },
        { name: 'To', value: ACCOUNT },
        { name: 'Subject', value: SUBJECT },
      ],
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          body: { data: Buffer.from(BODY, 'utf8').toString('base64url') },
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'attachment-never-print.pdf',
          body: {
            attachmentId: 'attachment-never-print',
            size: 99,
          },
        },
      ],
    },
  } satisfies gmail_v1.Schema$Message;
}

function fakeSurface(options: FakeOptions = {}): {
  readonly surface: GmailAcceptanceGoogleApisSurface;
  readonly calls: FakeCalls;
} {
  const calls: FakeCalls = {
    profile: [],
    history: [],
    messageList: [],
    messageGet: [],
    requestOptions: [],
    oauthClientCreate: 0,
    gmailClientCreate: 0,
    send: 0,
    watch: 0,
    modify: 0,
    delete: 0,
    attachmentGet: 0,
  };
  const auth: GmailAcceptanceOAuthClient = {
    setCredentials: () => undefined,
    getAccessToken: () =>
      options.stalledOAuth
        ? new Promise(() => undefined)
        : Promise.resolve({ token: OPAQUE_ACCESS_FIXTURE }),
    getTokenInfo: () =>
      Promise.resolve({
        aud: options.tokenAudience ?? CLIENT_ID,
        scopes: options.scopes ?? [...GMAIL_READ_ONLY_OAUTH_SCOPES],
        expiry_date:
          options.expiryDate ?? Date.parse('2026-07-17T13:00:00.000Z'),
      }),
  };
  const gmail = {
    users: {
      getProfile: (
        params: gmail_v1.Params$Resource$Users$Getprofile,
        requestOptions?: unknown,
      ) => {
        calls.profile.push(params);
        calls.requestOptions.push(requestOptions);
        if (options.stalledProfile) return new Promise(() => undefined);
        return Promise.resolve({
          data: {
            emailAddress: options.profileAccount ?? ACCOUNT,
            historyId: '100',
            messagesTotal: 7,
            threadsTotal: 4,
          },
        });
      },
      history: {
        list: (
          params: gmail_v1.Params$Resource$Users$History$List,
          requestOptions?: unknown,
        ) => {
          calls.history.push(params);
          calls.requestOptions.push(requestOptions);
          if (options.historyError !== undefined) {
            return Promise.reject(options.historyError);
          }
          const nextPageToken =
            options.historyPagination === 'stall'
              ? 'history-page-a'
              : options.historyPagination === 'cycle'
                ? params.pageToken === undefined
                  ? 'history-page-a'
                  : params.pageToken === 'history-page-a'
                    ? 'history-page-b'
                    : 'history-page-a'
                : undefined;
          const history =
            options.emptyHistory || options.historyPagination
              ? []
              : Array.from(
                  { length: options.oversizedHistory ? 3 : 1 },
                  (_value, index) => ({
                    id: String(101 + index),
                    messagesAdded: Array.from(
                      {
                        length: options.oversizedHistoryReferences ? 3 : 1,
                      },
                      () => ({
                        message: { id: MESSAGE_ID, threadId: THREAD_ID },
                      }),
                    ),
                  }),
                );
          return Promise.resolve({
            data: {
              historyId: '101',
              history,
              ...(nextPageToken === undefined ? {} : { nextPageToken }),
            },
          });
        },
      },
      messages: {
        list: (
          params: gmail_v1.Params$Resource$Users$Messages$List,
          requestOptions?: unknown,
        ) => {
          calls.messageList.push(params);
          calls.requestOptions.push(requestOptions);
          const secondPage = params.pageToken === 'page-token-never-print';
          const nextPageToken =
            options.backfillPagination === 'stall'
              ? 'backfill-page-a'
              : options.backfillPagination === 'cycle'
                ? params.pageToken === undefined
                  ? 'backfill-page-a'
                  : params.pageToken === 'backfill-page-a'
                    ? 'backfill-page-b'
                    : 'backfill-page-a'
                : options.pagedBackfill && !secondPage
                  ? 'page-token-never-print'
                  : undefined;
          return Promise.resolve({
            data: {
              messages: options.backfillPagination
                ? []
                : [
                    {
                      id: secondPage ? 'provider-message-second' : MESSAGE_ID,
                      threadId: secondPage
                        ? 'provider-thread-second'
                        : THREAD_ID,
                    },
                  ],
              ...(nextPageToken === undefined ? {} : { nextPageToken }),
            },
          });
        },
        get: (
          params: gmail_v1.Params$Resource$Users$Messages$Get,
          requestOptions?: unknown,
        ) => {
          calls.messageGet.push(params);
          calls.requestOptions.push(requestOptions);
          const second = params.id === 'provider-message-second';
          return Promise.resolve({
            data: providerMessage(
              options.messageIdSubstitution
                ? `${params.id}-substituted`
                : params.id,
              options.threadMismatch
                ? 'wrong-thread-never-print'
                : second
                  ? 'provider-thread-second'
                  : THREAD_ID,
            ),
          });
        },
        send: () => {
          calls.send += 1;
          throw new Error('send must not run');
        },
        modify: () => {
          calls.modify += 1;
          throw new Error('modify must not run');
        },
        delete: () => {
          calls.delete += 1;
          throw new Error('delete must not run');
        },
        attachments: {
          get: () => {
            calls.attachmentGet += 1;
            throw new Error('attachment fetch must not run');
          },
        },
      },
      watch: () => {
        calls.watch += 1;
        throw new Error('watch must not run');
      },
    },
  } as unknown as gmail_v1.Gmail;
  return {
    surface: {
      createOAuth2Client: () => {
        calls.oauthClientCreate += 1;
        return auth;
      },
      createGmailClient: () => {
        calls.gmailClientCreate += 1;
        return gmail;
      },
    },
    calls,
  };
}

function input(
  surface: GmailAcceptanceGoogleApisSurface,
  overrides: Partial<GmailAcceptanceRunInput> = {},
): GmailAcceptanceRunInput {
  const oauthClient = {
    clientId: CLIENT_ID,
    redirectUri: 'http://127.0.0.1/oauth/callback',
    applicationType: 'installed',
  } as GmailAcceptanceRunInput['oauthClient'];
  Reflect.set(oauthClient, 'clientSecret', OPAQUE_CLIENT_FIXTURE);
  const request = {
    oauthClient,
    expectedAccount: ACCOUNT,
    googleApis: surface,
    now: () => NOW,
    maxItems: 2,
    maxPages: 1,
    ...overrides,
  } as GmailAcceptanceRunInput;
  if (!Reflect.has(request, 'refreshToken')) {
    Reflect.set(request, 'refreshToken', OPAQUE_REFRESH_FIXTURE);
  }
  return request;
}

function checkpointWithIdentity(
  checkpoint: Omit<GmailAcceptanceCheckpoint, 'checkpointIdentityHash'>,
): GmailAcceptanceCheckpoint {
  const canonical = Object.fromEntries(
    Object.entries(checkpoint).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return {
    ...checkpoint,
    checkpointIdentityHash: createHash('sha256')
      .update(JSON.stringify(canonical), 'utf8')
      .digest('hex'),
  };
}

function replaceCheckpointIdentity(
  checkpoint: GmailAcceptanceCheckpoint,
  overrides: Readonly<Record<string, unknown>>,
): GmailAcceptanceCheckpoint {
  const { checkpointIdentityHash: _identity, ...continuation } = checkpoint;
  void _identity;
  return checkpointWithIdentity({
    ...continuation,
    ...overrides,
  });
}

function encodedCursor(value: Readonly<Record<string, unknown>>): string {
  return `gmail-acceptance:v1:${Buffer.from(
    JSON.stringify(value),
    'utf8',
  ).toString('base64url')}`;
}

describe('Gmail read-only live acceptance', () => {
  it('uses only bounded read endpoints and emits content-free evidence', async () => {
    const fake = fakeSurface();
    const result = await runGmailReadOnlyAcceptance(input(fake.surface));
    const serialized = JSON.stringify(result.report);

    expect(gmailConnectorDescriptor().authorizationScopes).toEqual([
      ...GMAIL_OAUTH_SCOPES,
    ]);
    expect(result.report.capability.scopes).toEqual([
      ...GMAIL_READ_ONLY_OAUTH_SCOPES,
    ]);
    expect(gmailConnectorDescriptor().capabilities).toMatchObject({
      read: true,
      send: true,
      externalEffect: true,
    });
    expect(result.report.capability.externalMutations).toBe(false);

    expect(result.report).toMatchObject({
      mode: 'read_only_acceptance',
      status: 'pass',
      issueCodes: [],
      transportPolicy: {
        retries: false,
        oauthTimeoutMilliseconds: 15_000,
        apiCallTimeoutMilliseconds: 10_000,
        overallTimeoutMilliseconds: 60_000,
      },
      observed: {
        historyEnvelopeCount: 1,
        backfillEnvelopeCount: 1,
        normalizedEnvelopeCount: 2,
        capturedMessageCount: 2,
        attachmentMetadataCount: 2,
        apiCalls: {
          profile: 1,
          historyList: 1,
          messageList: 1,
          messageGet: 2,
          unexpected: 0,
          mutations: 0,
        },
      },
    });
    for (const sensitive of [
      ACCOUNT,
      CLIENT_ID,
      OPAQUE_REFRESH_FIXTURE,
      OPAQUE_ACCESS_FIXTURE,
      MESSAGE_ID,
      THREAD_ID,
      BODY,
      SUBJECT,
      'attachment-never-print',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(fake.calls).toMatchObject({
      send: 0,
      watch: 0,
      modify: 0,
      delete: 0,
      attachmentGet: 0,
    });
    expect(fake.calls.history[0]).toMatchObject({
      userId: 'me',
      maxResults: 2,
      historyTypes: ['messageAdded'],
    });
    expect(fake.calls.messageList[0]).toMatchObject({
      userId: 'me',
      maxResults: 2,
      includeSpamTrash: true,
    });
    expect(fake.calls.messageGet.every(({ format }) => format === 'full')).toBe(
      true,
    );
    expect(
      fake.calls.requestOptions.every((options) => {
        const record = options as Readonly<Record<string, unknown>>;
        return (
          record.retry === false &&
          record.timeout === GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS &&
          record.signal instanceof AbortSignal
        );
      }),
    ).toBe(true);
  });

  it('produces deterministic content and provider hashes', async () => {
    const first = fakeSurface();
    const second = fakeSurface();
    const firstResult = await runGmailReadOnlyAcceptance(input(first.surface));
    const secondResult = await runGmailReadOnlyAcceptance(
      input(second.surface),
    );
    expect(firstResult.report.evidence.normalizedSetHash).toBe(
      secondResult.report.evidence.normalizedSetHash,
    );
    expect(firstResult.report.evidence.providerResponseSetHash).toBe(
      secondResult.report.evidence.providerResponseSetHash,
    );
    expect(firstResult.report.evidence.checkpointIdentityHash).toBe(
      secondResult.report.evidence.checkpointIdentityHash,
    );
  });

  it('resumes a bounded backfill from the original fence and page', async () => {
    const first = fakeSurface({ pagedBackfill: true });
    const firstResult = await runGmailReadOnlyAcceptance(input(first.surface));
    expect(firstResult.report.checkpoint.backfillComplete).toBe(false);
    expect(firstResult.report.checkpoint.resumed).toBe(false);

    const second = fakeSurface({ pagedBackfill: true });
    const secondResult = await runGmailReadOnlyAcceptance(
      input(second.surface, { checkpoint: firstResult.checkpoint }),
    );
    expect(secondResult.report.checkpoint).toMatchObject({
      resumed: true,
      backfillComplete: true,
    });
    expect(second.calls.messageList).toHaveLength(1);
    expect(second.calls.messageList[0]).toMatchObject({
      pageToken: 'page-token-never-print',
    });
    expect(secondResult.checkpoint.backfillFence).toBeUndefined();
    expect(secondResult.checkpoint.backfillPageToken).toBeUndefined();
  });

  it('skips initial backfill after a completed checkpoint', async () => {
    const first = fakeSurface();
    const firstResult = await runGmailReadOnlyAcceptance(input(first.surface));
    const resumed = fakeSurface();
    const resumedResult = await runGmailReadOnlyAcceptance(
      input(resumed.surface, { checkpoint: firstResult.checkpoint }),
    );
    expect(resumedResult.report.checkpoint).toMatchObject({
      resumed: true,
      backfillComplete: true,
    });
    expect(resumedResult.report.observed.backfillEnvelopeCount).toBe(0);
    expect(resumed.calls.messageList).toHaveLength(0);
    expect(resumed.calls.history).toHaveLength(1);
  });

  it.each([
    ['history', {}, { messageIdSubstitution: true }],
    [
      'backfill',
      { emptyHistory: true },
      { emptyHistory: true, messageIdSubstitution: true },
    ],
  ] as const)(
    'rejects same-thread message ID substitution during %s',
    async (_name, _firstOptions, fakeOptions) => {
      const fake = fakeSurface(fakeOptions);
      await expect(
        runGmailReadOnlyAcceptance(input(fake.surface)),
      ).rejects.toMatchObject({
        code: 'GMAIL_ACCEPTANCE_MESSAGE_ID_MISMATCH',
      });
    },
  );

  it('rejects aggregate history message references before advancing', async () => {
    const fake = fakeSurface({ oversizedHistoryReferences: true });
    await expect(
      runGmailReadOnlyAcceptance(input(fake.surface)),
    ).rejects.toMatchObject({
      code: 'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
    });
    expect(fake.calls.messageGet).toHaveLength(0);
  });

  it.each([
    ['history stall', { historyPagination: 'stall' }, 2],
    ['history cycle', { historyPagination: 'cycle' }, 3],
    ['backfill stall', { emptyHistory: true, backfillPagination: 'stall' }, 2],
    ['backfill cycle', { emptyHistory: true, backfillPagination: 'cycle' }, 3],
  ] as const)(
    'rejects pagination non-progress for %s',
    async (_name, fakeOptions, maxPages) => {
      const fake = fakeSurface(fakeOptions);
      await expect(
        runGmailReadOnlyAcceptance(
          input(fake.surface, { maxItems: 5, maxPages }),
        ),
      ).rejects.toMatchObject({
        code: 'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      });
    },
  );

  it.each([
    [
      'constraint',
      (descriptor: ReturnType<typeof gmailConnectorDescriptor>) => ({
        ...descriptor,
        constraints: [
          ...descriptor.constraints,
          'material checkpoint-binding drift',
        ],
      }),
    ],
    [
      'supported runtime mode',
      (descriptor: ReturnType<typeof gmailConnectorDescriptor>) => ({
        ...descriptor,
        supportedRuntimeModes: descriptor.supportedRuntimeModes.filter(
          (mode) => mode !== 'disabled',
        ),
      }),
    ],
  ] as const)(
    'invalidates a checkpoint when a material descriptor %s drifts before OAuth',
    async (_name, drift) => {
      const initial = fakeSurface();
      const initialResult = await runGmailReadOnlyAcceptance(
        input(initial.surface),
      );
      const currentDescriptor = gmailConnectorDescriptor();
      const descriptorSpy = vi
        .spyOn(descriptorModule, 'gmailConnectorDescriptor')
        .mockReturnValue(drift(currentDescriptor));
      const resumed = fakeSurface();
      try {
        await expect(
          runGmailReadOnlyAcceptance(
            input(resumed.surface, { checkpoint: initialResult.checkpoint }),
          ),
        ).rejects.toMatchObject({
          code: 'GMAIL_ACCEPTANCE_CHECKPOINT_INVALID',
        });
        expect(resumed.calls.oauthClientCreate).toBe(0);
        expect(resumed.calls.gmailClientCreate).toBe(0);
        expect(resumed.calls.profile).toHaveLength(0);
        expect(resumed.calls.history).toHaveLength(0);
      } finally {
        descriptorSpy.mockRestore();
      }
    },
  );

  it.each([
    ['history', { historyPagination: 'stall' }],
    ['backfill', { emptyHistory: true, backfillPagination: 'stall' }],
  ] as const)(
    'rejects resumed %s pagination returning the same token',
    async (_name, fakeOptions) => {
      const first = fakeSurface(fakeOptions);
      const firstResult = await runGmailReadOnlyAcceptance(
        input(first.surface, { maxPages: 1 }),
      );
      const resumed = fakeSurface(fakeOptions);
      await expect(
        runGmailReadOnlyAcceptance(
          input(resumed.surface, {
            maxPages: 1,
            checkpoint: firstResult.checkpoint,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
      });
    },
  );

  it.each([
    [
      'scope drift',
      { scopes: [...GMAIL_READ_ONLY_OAUTH_SCOPES, 'openid'] },
      {},
      'GMAIL_ACCEPTANCE_OAUTH_SCOPE_DRIFT',
    ],
    [
      'audience drift',
      { tokenAudience: 'other-client.apps.example.invalid' },
      {},
      'GMAIL_ACCEPTANCE_OAUTH_AUDIENCE_MISMATCH',
    ],
    [
      'stale token',
      { expiryDate: Date.parse(NOW) },
      {},
      'GMAIL_ACCEPTANCE_TOKEN_STALE',
    ],
    [
      'wrong account',
      { profileAccount: 'wrong@example.invalid' },
      {},
      'GMAIL_ACCEPTANCE_WRONG_ACCOUNT',
    ],
    [
      'history reset',
      {
        historyError: Object.assign(new Error('provider detail not logged'), {
          response: { status: 404 },
        }),
      },
      {},
      'GMAIL_ACCEPTANCE_HISTORY_RESET',
    ],
    [
      'message/thread mismatch',
      { threadMismatch: true },
      {},
      'GMAIL_ACCEPTANCE_MESSAGE_THREAD_MISMATCH',
    ],
    [
      'history response cardinality overrun',
      { oversizedHistory: true },
      {},
      'GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN',
    ],
    [
      'hard item maximum',
      {},
      { maxItems: GMAIL_ACCEPTANCE_HARD_MAX_ITEMS + 1 },
      'GMAIL_ACCEPTANCE_ARGUMENT_INVALID',
    ],
    [
      'missing refresh token',
      {},
      { refreshToken: ' ' },
      'GMAIL_ACCEPTANCE_REFRESH_TOKEN_INVALID',
    ],
    [
      'malformed expected account',
      {},
      { expectedAccount: 'not-an-account' },
      'GMAIL_ACCEPTANCE_EXPECTED_ACCOUNT_INVALID',
    ],
  ] as const)(
    'fails closed for %s',
    async (_name, fakeOptions, overrides, expectedCode) => {
      const fake = fakeSurface(fakeOptions);
      await expect(
        runGmailReadOnlyAcceptance(input(fake.surface, overrides)),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(fake.calls).toMatchObject({
        send: 0,
        watch: 0,
        modify: 0,
        delete: 0,
        attachmentGet: 0,
      });
    },
  );

  it('rejects every unexpected or mutating Gmail method at the guard', () => {
    const fake = fakeSurface();
    const rawGmail = fake.surface.createGmailClient(
      fake.surface.createOAuth2Client({
        clientId: CLIENT_ID,
        clientSecret: 'not-printed',
        redirectUri: 'http://127.0.0.1',
        applicationType: 'installed',
      }),
    );
    const guard = createReadOnlyAcceptanceGmailGuard(rawGmail, {
      maxItems: 2,
      maxPages: 1,
    });
    expect(() => guard.gmail.users.messages.send({ userId: 'me' })).toThrow(
      'GMAIL_ACCEPTANCE_SEND_FORBIDDEN',
    );
    expect(() =>
      guard.gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: 'forbidden',
        id: 'forbidden',
      }),
    ).toThrow('GMAIL_ACCEPTANCE_UNEXPECTED_API_METHOD');
    expect(guard.counts).toMatchObject({ unexpected: 2, mutations: 1 });
    expect(fake.calls).toMatchObject({ send: 0, attachmentGet: 0 });
  });

  it('fails closed instead of evicting a saturated pagination trail', async () => {
    const fake = fakeSurface({ historyPagination: 'stall' });
    const rawGmail = fake.surface.createGmailClient(
      fake.surface.createOAuth2Client({
        clientId: CLIENT_ID,
        clientSecret: 'not-printed',
        redirectUri: 'http://127.0.0.1',
        applicationType: 'installed',
      }),
    );
    const guard = createReadOnlyAcceptanceGmailGuard(
      rawGmail,
      { maxItems: 2, maxPages: 1 },
      {
        history: Array.from({ length: 12 }, (_value, index) =>
          String(index).padStart(64, '0'),
        ),
      },
    );
    await expect(
      guard.gmail.users.history.list({
        userId: 'me',
        startHistoryId: '100',
        historyTypes: ['messageAdded'],
        maxResults: 2,
      }),
    ).rejects.toThrow('GMAIL_ACCEPTANCE_PROVIDER_PAGINATION_OVERRUN');
    expect(guard.tokenHashes.history).toHaveLength(12);
  });

  it.each([
    [
      'identity tamper',
      (checkpoint: GmailAcceptanceCheckpoint) => ({
        ...checkpoint,
        checkpointEpoch: checkpoint.checkpointEpoch + 1,
      }),
    ],
    [
      'unknown field',
      (checkpoint: GmailAcceptanceCheckpoint) =>
        replaceCheckpointIdentity(checkpoint, { unexpected: true }),
    ],
    [
      'cursor unknown field',
      (checkpoint: GmailAcceptanceCheckpoint) =>
        replaceCheckpointIdentity(checkpoint, {
          historyCursor: encodedCursor({ historyId: '101', unexpected: true }),
        }),
    ],
    [
      'cursor token without latest watermark',
      (checkpoint: GmailAcceptanceCheckpoint) =>
        replaceCheckpointIdentity(checkpoint, {
          historyCursor: encodedCursor({
            historyId: '101',
            pageToken: 'page-a',
          }),
        }),
    ],
    [
      'watermark mismatch',
      (checkpoint: GmailAcceptanceCheckpoint) =>
        replaceCheckpointIdentity(checkpoint, {
          historyWatermarkHash: 'd'.repeat(64),
        }),
    ],
    [
      'token trail mismatch',
      (checkpoint: GmailAcceptanceCheckpoint) =>
        replaceCheckpointIdentity(checkpoint, {
          historyPageTokenHashes: ['e'.repeat(64)],
        }),
    ],
  ] as const)(
    'rejects checkpoint %s before OAuth or provider activity',
    async (_name, mutate) => {
      const first = fakeSurface();
      const firstResult = await runGmailReadOnlyAcceptance(
        input(first.surface),
      );
      const resumed = fakeSurface();
      await expect(
        runGmailReadOnlyAcceptance(
          input(resumed.surface, {
            checkpoint: mutate(firstResult.checkpoint),
          }),
        ),
      ).rejects.toMatchObject({ code: 'GMAIL_ACCEPTANCE_CHECKPOINT_INVALID' });
      expect(resumed.calls.oauthClientCreate).toBe(0);
      expect(resumed.calls.gmailClientCreate).toBe(0);
      expect(resumed.calls.profile).toHaveLength(0);
      expect(resumed.calls.history).toHaveLength(0);
    },
  );

  it.each([
    [
      'OAuth',
      { stalledOAuth: true },
      GMAIL_ACCEPTANCE_OAUTH_TIMEOUT_MILLISECONDS,
    ],
    [
      'Gmail',
      { stalledProfile: true },
      GMAIL_ACCEPTANCE_API_TIMEOUT_MILLISECONDS,
    ],
  ] as const)(
    'fails closed when a %s call exceeds its fixed deadline',
    async (_name, fakeOptions, timeoutMilliseconds) => {
      vi.useFakeTimers();
      try {
        const fake = fakeSurface(fakeOptions);
        const pending = runGmailReadOnlyAcceptance(input(fake.surface));
        const rejection = expect(pending).rejects.toMatchObject({
          code: 'GMAIL_ACCEPTANCE_TIMEOUT',
        });
        await vi.advanceTimersByTimeAsync(timeoutMilliseconds);
        await rejection;
        expect(fake.calls).toMatchObject({
          send: 0,
          watch: 0,
          modify: 0,
          delete: 0,
          attachmentGet: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('fails closed if an evidence shape introduces content-bearing keys', () => {
    expect(() =>
      assertContentSafeAcceptanceEvidence({ subject: SUBJECT }),
    ).toThrow('GMAIL_ACCEPTANCE_BODY_OR_ATTACHMENT_LEAKAGE');
  });

  it('maps arbitrary provider failures to one redacted issue code', () => {
    expect(
      acceptanceIssueCode(
        new Error(
          `provider leaked ${OPAQUE_ACCESS_FIXTURE} ${ACCOUNT} ${BODY}`,
        ),
      ),
    ).toBe('GMAIL_ACCEPTANCE_UNEXPECTED_FAILURE');
  });
});

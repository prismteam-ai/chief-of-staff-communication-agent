import { describe, expect, it, vi } from 'vitest';
import { AccountAccessDeniedError } from '@chief-of-staff/shared';
import type { Connector, SendResult } from '@chief-of-staff/connectors';
import {
  SendAlreadyClaimedError,
  TransitionConflictError,
  type ApiCommunicationRecord,
  type CommunicationsRepo,
} from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import {
  ApprovalService,
  CommunicationNotFoundError,
  IllegalActionError,
} from './approval-service.js';

const NOW = () => new Date('2026-07-16T18:00:00.000Z');
const ACCOUNT_ID = 'acct-gmail-demoalex775';
const OWNER_USER_ID = 'demo-alex';
const OTHER_USER_ID = 'someone-else';
const COMM_ID = 'gmail#19f6aff00ee81d98';

function fixtureRecord(overrides: Partial<ApiCommunicationRecord> = {}): ApiCommunicationRecord {
  return {
    commId: COMM_ID,
    accountId: ACCOUNT_ID,
    schemaVersion: 1,
    channelType: 'gmail',
    externalId: '19f6aff00ee81d98',
    threadKey: '19f6aff00ee81d98',
    participants: [
      { id: 'demoalex775@gmail.com', role: 'from' },
      { id: 'renee.castellano@harborline-partners.com', displayName: 'Renee', role: 'to' },
    ],
    ts: '2026-07-16T12:55:24.000Z',
    body: 'Thanks for confirming.',
    attachments: [],
    status: 'drafted',
    ingestedAt: '2026-07-16T12:56:24.283Z',
    recommendation: {
      commId: COMM_ID,
      accountId: ACCOUNT_ID,
      actionType: 'reply_needed',
      confidence: 0.82,
      rationale: 'Needs a reply.',
    },
    draft: {
      commId: COMM_ID,
      accountId: ACCOUNT_ID,
      body: 'Thanks — noted.',
      confidence: 0.72,
    },
    transitions: [],
    ...overrides,
  };
}

function fakeCommunicationsRepo(
  initial: ApiCommunicationRecord,
): CommunicationsRepo & { record: ApiCommunicationRecord } {
  const state = { record: { ...initial } };
  return {
    get record() {
      return state.record;
    },
    async getById(commId) {
      return commId === state.record.commId ? { ...state.record } : undefined;
    },
    async listByAccount(accountId, status) {
      if (state.record.accountId !== accountId) return [];
      if (status && state.record.status !== status) return [];
      return [{ ...state.record }];
    },
    async transition(record, patch) {
      if (state.record.status !== record.from) {
        throw new TransitionConflictError(record.commId, record.from);
      }
      state.record = {
        ...state.record,
        status: record.to,
        transitions: [...(state.record.transitions ?? []), record],
        ...(patch?.draft ? { draft: patch.draft } : {}),
      };
    },
    async claimSend(commId, priorClaimedAt) {
      const isRetry = priorClaimedAt !== undefined;
      const casOk = isRetry
        ? state.record.sendClaimedAt === priorClaimedAt && !state.record.sentMessageId
        : !state.record.sendClaimedAt;
      if (!casOk) {
        throw new SendAlreadyClaimedError(commId);
      }
      state.record = { ...state.record, sendClaimedAt: NOW().toISOString() };
    },
    async recordSent(commId, sentMessageId) {
      state.record = { ...state.record, sentMessageId };
    },
  };
}

function fakeAccountsRepo(
  ownership: Record<string, string>,
  ownAddresses: Record<string, string> = { [ACCOUNT_ID]: 'demoalex775@gmail.com' },
): AccountsRepo {
  return {
    async getOwner(accountId) {
      return ownership[accountId];
    },
    async getOwnAddress(accountId) {
      return ownAddresses[accountId];
    },
  };
}

function fakeConnector(sendImpl?: () => Promise<SendResult>): Connector {
  return {
    channelType: 'gmail',
    async ingest() {
      return [];
    },
    async identity(_participantId, accountId) {
      return { accountId };
    },
    send: sendImpl ?? (async () => ({ providerMessageId: 'sent-fake-1' })),
  };
}

function makeService(
  record: ApiCommunicationRecord,
  opts: { sendImpl?: () => Promise<SendResult>; ownership?: Record<string, string> } = {},
) {
  const repo = fakeCommunicationsRepo(record);
  const accountsRepo = fakeAccountsRepo(opts.ownership ?? { [ACCOUNT_ID]: OWNER_USER_ID });
  const connector = fakeConnector(opts.sendImpl);
  const metricsClient = { addMetric: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const service = new ApprovalService({
    communicationsRepo: repo,
    accountsRepo,
    connectorFor: () => connector,
    now: NOW,
    log,
    metricsClient,
  });

  return { service, repo, metricsClient, log };
}

describe('ApprovalService — account permission guard', () => {
  it('listCommunications denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord(), {
      ownership: { [ACCOUNT_ID]: OWNER_USER_ID },
    });
    await expect(
      service.listCommunications({ accountId: ACCOUNT_ID, userId: OTHER_USER_ID }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it('getCommunication denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(
      service.getCommunication({ commId: COMM_ID, userId: OTHER_USER_ID }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it('approveDraft denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(service.approveDraft({ commId: COMM_ID, userId: OTHER_USER_ID })).rejects.toThrow(
      AccountAccessDeniedError,
    );
  });

  it('editDraft denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(
      service.editDraft({ commId: COMM_ID, userId: OTHER_USER_ID, newBody: 'x' }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it('rejectDraft denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(service.rejectDraft({ commId: COMM_ID, userId: OTHER_USER_ID })).rejects.toThrow(
      AccountAccessDeniedError,
    );
  });

  it('dismiss denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(service.dismiss({ commId: COMM_ID, userId: OTHER_USER_ID })).rejects.toThrow(
      AccountAccessDeniedError,
    );
  });

  it('supplyContext denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord({ status: 'needs_context' }));
    await expect(
      service.supplyContext({ commId: COMM_ID, userId: OTHER_USER_ID, text: 'more info' }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it('a legitimate owner is allowed through the guard (control case)', async () => {
    const { service } = makeService(fixtureRecord());
    const result = await service.getCommunication({ commId: COMM_ID, userId: OWNER_USER_ID });
    expect(result.commId).toBe(COMM_ID);
  });
});

describe('ApprovalService — listCommunications / getCommunication', () => {
  it('lists communications for an owned account, optionally filtered by status', async () => {
    const { service } = makeService(fixtureRecord({ status: 'drafted' }));
    const result = await service.listCommunications({
      accountId: ACCOUNT_ID,
      userId: OWNER_USER_ID,
      status: 'drafted',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('drafted');
  });

  it('getCommunication throws CommunicationNotFoundError for an unknown id', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(
      service.getCommunication({ commId: 'gmail#does-not-exist', userId: OWNER_USER_ID }),
    ).rejects.toThrow(CommunicationNotFoundError);
  });
});

describe('ApprovalService — approveDraft (drafted -> awaiting_approval -> approved -> sent -> answered)', () => {
  it('drives the full transition chain and persists the provider sent id', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }), {
      sendImpl: async () => ({ providerMessageId: 'sent-message-99' }),
    });

    const result = await service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    expect(result.status).toBe('answered');
    expect(repo.record.status).toBe('answered');
    expect(repo.record.sentMessageId).toBe('sent-message-99');
    // Audit trail: drafted->awaiting_approval->approved->sent->answered, all timestamped.
    const path = repo.record.transitions?.map((t) => `${t.from}->${t.to}`);
    expect(path).toEqual([
      'drafted->awaiting_approval',
      'awaiting_approval->approved',
      'approved->sent',
      'sent->answered',
    ]);
    for (const t of repo.record.transitions ?? []) {
      expect(t.ts).toBe(NOW().toISOString());
      expect(t.actorId).toBe(OWNER_USER_ID);
    }
  });

  it('sends to the counterpart, not back to the account\'s own mailbox, even when that message tagged the account as "from"', async () => {
    // Regression case, confirmed against live seeded data: some persisted communications are the
    // account's OWN sent mail replayed through ingestion, so `demoalex775@gmail.com` ends up
    // tagged role:"from" even though Alex is the account owner, not the counterpart. Naively
    // trusting role:"from" would send the reply back to the account's own inbox.
    let capturedTo: string[] | undefined;
    const record = fixtureRecord({
      status: 'drafted',
      participants: [
        { id: 'demoalex775@gmail.com', role: 'from' },
        { id: 'renee.castellano@harborline-partners.com', displayName: 'Renee', role: 'to' },
      ],
    });
    const repo = fakeCommunicationsRepo(record);
    const accountsRepo = fakeAccountsRepo({ [ACCOUNT_ID]: OWNER_USER_ID });
    const captureService = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo,
      connectorFor: () => ({
        channelType: 'gmail',
        async ingest() {
          return [];
        },
        async identity(_id, accountId) {
          return { accountId };
        },
        async send(message) {
          capturedTo = message.to;
          return { providerMessageId: 'sent-1' };
        },
      }),
      now: NOW,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    await captureService.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    expect(capturedTo).toEqual(['renee.castellano@harborline-partners.com']);
  });

  it("sends to the account's own address for a pure self-thread (every participant is the account itself)", async () => {
    // Regression case, found live during Task 6 verification: `just verify-ingest`'s
    // self-addressed probe (Gmail's documented self-send behavior on this account: the sent
    // message id gains the INBOX label rather than creating a distinct copy) produces a
    // NormalizedMessage where BOTH participants are the account's own address
    // (demoalex775@gmail.com tagged "from" AND "to"). The "everyone except myself" filter alone
    // would leave zero recipients here, which must fall back to the account's own address —
    // there being no other party to address a reply to — rather than sending to nobody.
    let capturedTo: string[] | undefined;
    const record = fixtureRecord({
      status: 'drafted',
      participants: [
        { id: 'demoalex775@gmail.com', role: 'from' },
        { id: 'demoalex775@gmail.com', role: 'to' },
      ],
    });
    const repo = fakeCommunicationsRepo(record);
    const accountsRepo = fakeAccountsRepo({ [ACCOUNT_ID]: OWNER_USER_ID });
    const captureService = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo,
      connectorFor: () => ({
        channelType: 'gmail',
        async ingest() {
          return [];
        },
        async identity(_id, accountId) {
          return { accountId };
        },
        async send(message) {
          capturedTo = message.to;
          return { providerMessageId: 'sent-1' };
        },
      }),
      now: NOW,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    await captureService.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    expect(capturedTo).toEqual(['demoalex775@gmail.com']);
  });

  it('also works starting from awaiting_approval directly (already opened for review)', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'awaiting_approval' }));
    const result = await service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });
    expect(result.status).toBe('answered');
    expect(repo.record.transitions?.map((t) => `${t.from}->${t.to}`)).toEqual([
      'awaiting_approval->approved',
      'approved->sent',
      'sent->answered',
    ]);
  });

  it('rejects approveDraft on a communication with no draft', async () => {
    const { service } = makeService(fixtureRecord({ status: 'drafted', draft: undefined }));
    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      IllegalActionError,
    );
  });

  it('rejects approveDraft on a communication in an illegal state (e.g. already answered)', async () => {
    const { service } = makeService(fixtureRecord({ status: 'answered' }));
    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      IllegalActionError,
    );
  });

  it('emits DraftApproved and ReplySent metrics on success', async () => {
    const { service, metricsClient } = makeService(fixtureRecord({ status: 'drafted' }));
    await service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    const metricNames = metricsClient.addMetric.mock.calls.map((call) => call[0]);
    expect(metricNames).toContain('DraftApproved');
    expect(metricNames).toContain('ReplySent');
  });

  it('idempotency: a second approveDraft call on an already-answered communication does not re-send', async () => {
    let sendCallCount = 0;
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }), {
      sendImpl: async () => {
        sendCallCount += 1;
        return { providerMessageId: `sent-${sendCallCount}` };
      },
    });

    await service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });
    expect(sendCallCount).toBe(1);
    expect(repo.record.status).toBe('answered');

    // Retried approval (e.g. a duplicate client request) — must not send again.
    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      IllegalActionError,
    );
    expect(sendCallCount).toBe(1);
  });

  it('emits SendFailed and leaves the record at approved (not sent) when the connector throws', async () => {
    const { service, repo, metricsClient } = makeService(fixtureRecord({ status: 'drafted' }), {
      sendImpl: async () => {
        throw new Error('Gmail API 500');
      },
    });

    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      'Gmail API 500',
    );

    expect(repo.record.status).toBe('approved');
    const metricNames = metricsClient.addMetric.mock.calls.map((call) => call[0]);
    expect(metricNames).toContain('SendFailed');
    expect(metricNames).not.toContain('ReplySent');
  });

  it('propagates SendAlreadyClaimedError (a concurrent approve already claimed the send)', async () => {
    const record = fixtureRecord({ status: 'drafted', sendClaimedAt: NOW().toISOString() });
    const { service } = makeService(record);
    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      SendAlreadyClaimedError,
    );
  });

  it('retry: a second approveDraft call on a record left at approved after a failed send succeeds and re-sends exactly once', async () => {
    let sendCallCount = 0;
    let shouldFail = true;
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }), {
      sendImpl: async () => {
        sendCallCount += 1;
        if (shouldFail) throw new Error('Gmail API 500');
        return { providerMessageId: 'sent-after-retry' };
      },
    });

    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      'Gmail API 500',
    );
    expect(repo.record.status).toBe('approved');
    expect(sendCallCount).toBe(1);

    shouldFail = false;
    const result = await service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    expect(sendCallCount).toBe(2);
    expect(result.status).toBe('answered');
    expect(result.sentMessageId).toBe('sent-after-retry');
  });

  it('retry: does not double-count DraftApproved metric (only emitted on the first hop into approved)', async () => {
    let shouldFail = true;
    const { service, repo, metricsClient } = makeService(fixtureRecord({ status: 'drafted' }), {
      sendImpl: async () => {
        if (shouldFail) throw new Error('Gmail API 500');
        return { providerMessageId: 'sent-after-retry' };
      },
    });

    await expect(
      service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID }),
    ).rejects.toThrow();
    shouldFail = false;
    await service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    const draftApprovedCount = metricsClient.addMetric.mock.calls.filter(
      (call) => call[0] === 'DraftApproved',
    ).length;
    expect(draftApprovedCount).toBe(1);
    expect(repo.record.status).toBe('answered');
  });

  it('rejects a retry whose CAS on the prior claim timestamp loses to a concurrent winner', async () => {
    // A record already at `approved` with a failed send behind it (the state a genuine retry
    // starts from). Before THIS call's `claimSend` CAS runs, a concurrent retry has already won
    // and re-claimed with a fresh timestamp — this call's `loadAuthorized` re-read still observed
    // the OLD `sendClaimedAt` (the read happened before the concurrent writer's update), so its
    // CAS is built on a now-stale prior value and must lose.
    const staleClaimedAt = NOW().toISOString();
    const record = fixtureRecord({ status: 'approved', sendClaimedAt: staleClaimedAt });
    const repo = fakeCommunicationsRepo(record);
    // The concurrent winner updates the repo's underlying state directly, simulating its own
    // successful claimSend landing between this call's read and its own claimSend CAS.
    repo.record.sendClaimedAt = new Date(NOW().getTime() + 1000).toISOString();

    const accountsRepo = fakeAccountsRepo({ [ACCOUNT_ID]: OWNER_USER_ID });
    const connector = fakeConnector();
    const service = new ApprovalService({
      communicationsRepo: {
        ...repo,
        // This call's `loadAuthorized` observes the stale claim (as if its read raced ahead of
        // the concurrent writer's commit) while every other repo call sees live state.
        async getById(commId) {
          return commId === record.commId
            ? { ...record, sendClaimedAt: staleClaimedAt }
            : undefined;
        },
      },
      accountsRepo,
      connectorFor: () => connector,
      now: NOW,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      SendAlreadyClaimedError,
    );
  });

  it('a communication stuck at approved with no draft still rejects (defensive — should not happen)', async () => {
    const { service } = makeService(fixtureRecord({ status: 'approved', draft: undefined }));
    await expect(service.approveDraft({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      IllegalActionError,
    );
  });
});

describe('ApprovalService — editDraft (-> awaiting_approval via the edited hop)', () => {
  it('updates the draft body and lands in awaiting_approval', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }));
    const result = await service.editDraft({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      newBody: 'A better reply.',
    });

    expect(result.status).toBe('awaiting_approval');
    expect(repo.record.draft?.body).toBe('A better reply.');
    expect(repo.record.transitions?.map((t) => `${t.from}->${t.to}`)).toEqual([
      'drafted->awaiting_approval',
      'awaiting_approval->edited',
      'edited->awaiting_approval',
    ]);
  });

  it('rejects an empty edited body', async () => {
    const { service } = makeService(fixtureRecord({ status: 'drafted' }));
    await expect(
      service.editDraft({ commId: COMM_ID, userId: OWNER_USER_ID, newBody: '   ' }),
    ).rejects.toThrow(IllegalActionError);
  });
});

describe('ApprovalService — rejectDraft (-> drafted, re-draft)', () => {
  it('moves the communication back to drafted for re-drafting', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }));
    const result = await service.rejectDraft({ commId: COMM_ID, userId: OWNER_USER_ID });

    expect(result.status).toBe('drafted');
    expect(repo.record.transitions?.map((t) => `${t.from}->${t.to}`)).toEqual([
      'drafted->awaiting_approval',
      'awaiting_approval->rejected',
      'rejected->drafted',
    ]);
  });
});

describe('ApprovalService — dismiss', () => {
  it('dismisses a drafted communication (no reply needed)', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }));
    const result = await service.dismiss({ commId: COMM_ID, userId: OWNER_USER_ID });

    expect(result.status).toBe('dismissed');
    expect(repo.record.transitions?.map((t) => `${t.from}->${t.to}`)).toEqual([
      'drafted->dismissed',
    ]);
  });

  it('dismisses a recommended communication directly (design.md §7 primary path)', async () => {
    const { service, repo } = makeService(
      fixtureRecord({ status: 'recommended', draft: undefined }),
    );
    const result = await service.dismiss({ commId: COMM_ID, userId: OWNER_USER_ID });
    expect(result.status).toBe('dismissed');
    expect(repo.record.transitions?.map((t) => `${t.from}->${t.to}`)).toEqual([
      'recommended->dismissed',
    ]);
  });

  it('emits CommunicationDismissed metric', async () => {
    const { service, metricsClient } = makeService(fixtureRecord({ status: 'drafted' }));
    await service.dismiss({ commId: COMM_ID, userId: OWNER_USER_ID });
    const metricNames = metricsClient.addMetric.mock.calls.map((call) => call[0]);
    expect(metricNames).toContain('CommunicationDismissed');
  });

  it('rejects dismissing a communication already answered', async () => {
    const { service } = makeService(fixtureRecord({ status: 'answered' }));
    await expect(service.dismiss({ commId: COMM_ID, userId: OWNER_USER_ID })).rejects.toThrow(
      IllegalActionError,
    );
  });
});

describe('ApprovalService — supplyContext (needs_context -> drafted)', () => {
  it('transitions needs_context back to drafted after context is supplied', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'needs_context' }));
    const result = await service.supplyContext({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      text: 'The renewal deadline is Friday.',
    });

    expect(result.status).toBe('drafted');
    expect(repo.record.transitions?.map((t) => `${t.from}->${t.to}`)).toEqual([
      'needs_context->drafted',
    ]);
  });

  it('rejects supplyContext on a communication not in needs_context', async () => {
    const { service } = makeService(fixtureRecord({ status: 'drafted' }));
    await expect(
      service.supplyContext({ commId: COMM_ID, userId: OWNER_USER_ID, text: 'x' }),
    ).rejects.toThrow(IllegalActionError);
  });

  it('rejects empty supplied context text', async () => {
    const { service } = makeService(fixtureRecord({ status: 'needs_context' }));
    await expect(
      service.supplyContext({ commId: COMM_ID, userId: OWNER_USER_ID, text: '  ' }),
    ).rejects.toThrow(IllegalActionError);
  });
});

describe('ApprovalService — audit trail timestamps', () => {
  it('every transition produced by every action carries the injected clock value', async () => {
    const { service, repo } = makeService(fixtureRecord({ status: 'drafted' }));
    await service.dismiss({ commId: COMM_ID, userId: OWNER_USER_ID });
    for (const t of repo.record.transitions ?? []) {
      expect(t.ts).toBe('2026-07-16T18:00:00.000Z');
    }
  });
});

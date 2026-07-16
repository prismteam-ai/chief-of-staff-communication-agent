import { describe, expect, it } from 'vitest';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { MetricsService } from './metrics-service.js';
import { AccountAccessDeniedError } from '@chief-of-staff/shared';

/**
 * Aggregation correctness + account-scoping tests (Task 8 brief constraint 10): fixture
 * communications in known states/channels/transition timestamps -> expected metric counts/
 * durations, and a proof that user A's metrics never include user B's account's records — the
 * SAME `assertAccountAccess` guard `ApprovalService`/`AsanaService` already route every read/write
 * through (design.md §10), applied here to the new aggregation surface (brief constraint 3).
 */

const ACCOUNT_A = 'acct-gmail-demoalex775';
const USER_A = 'demo-alex';
const ACCOUNT_B = 'acct-gmail-otheruser';
const USER_B = 'demo-blair';

function fixture(overrides: Partial<ApiCommunicationRecord>): ApiCommunicationRecord {
  return {
    commId: `gmail#${Math.random().toString(36).slice(2)}`,
    accountId: ACCOUNT_A,
    schemaVersion: 1,
    channelType: 'gmail',
    externalId: 'ext-1',
    threadKey: 'thread-1',
    participants: [{ id: 'demoalex775@gmail.com', role: 'from' }],
    ts: '2026-07-16T12:00:00.000Z',
    body: 'hello',
    attachments: [],
    status: 'ingested',
    ingestedAt: '2026-07-16T12:00:05.000Z',
    ...overrides,
  };
}

function inMemoryRepo(records: ApiCommunicationRecord[]): CommunicationsRepo {
  return {
    async getById(commId) {
      return records.find((r) => r.commId === commId);
    },
    async listByAccount(accountId, status) {
      return records.filter((r) => r.accountId === accountId && (!status || r.status === status));
    },
    async transition() {
      throw new Error('not used in metrics tests');
    },
    async claimSend() {
      throw new Error('not used in metrics tests');
    },
    async recordSent() {
      throw new Error('not used in metrics tests');
    },
    async linkAsanaTask() {
      throw new Error('not used in metrics tests');
    },
  };
}

function accountsRepo(): AccountsRepo {
  return {
    async getOwner(accountId) {
      if (accountId === ACCOUNT_A) return USER_A;
      if (accountId === ACCOUNT_B) return USER_B;
      return undefined;
    },
    async getOwnAddress() {
      return undefined;
    },
    async listByUser() {
      return [];
    },
  };
}

describe('MetricsService.getDashboardMetrics — aggregation correctness', () => {
  it('computes volume, channel breakdown, response-status breakdown, and pending-approvals count', async () => {
    const records = [
      fixture({ commId: 'a', status: 'ingested', channelType: 'gmail' }),
      fixture({ commId: 'b', status: 'drafted', channelType: 'gmail' }),
      fixture({ commId: 'c', status: 'awaiting_approval', channelType: 'sms' }),
      fixture({ commId: 'd', status: 'answered', channelType: 'gmail' }),
      fixture({ commId: 'e', status: 'dismissed', channelType: 'sms' }),
      fixture({ commId: 'f', status: 'needs_context', channelType: 'gmail' }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
      now: () => new Date('2026-07-16T13:00:00.000Z'),
    });

    const metrics = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });

    expect(metrics.totalVolume).toBe(6);
    expect(metrics.channelBreakdown).toEqual({ gmail: 4, sms: 2 });
    expect(metrics.statusBreakdown.ingested).toBe(1);
    expect(metrics.statusBreakdown.drafted).toBe(1);
    expect(metrics.statusBreakdown.awaiting_approval).toBe(1);
    expect(metrics.statusBreakdown.answered).toBe(1);
    expect(metrics.statusBreakdown.dismissed).toBe(1);
    expect(metrics.statusBreakdown.needs_context).toBe(1);
    // Pending approvals: drafted + awaiting_approval + needs_context (the human-actionable queue).
    expect(metrics.pendingApprovalsCount).toBe(3);
    // Handled = answered ∪ dismissed (state-machine.ts's isHandled).
    expect(metrics.handledCount).toBe(2);
  });

  it('flags overdue: unanswered/undismissed communications older than 5 minutes since ingestedAt', async () => {
    const records = [
      // Ingested 10 minutes before "now" and still unhandled -> overdue.
      fixture({ commId: 'stale', status: 'drafted', ingestedAt: '2026-07-16T12:50:00.000Z' }),
      // Ingested 2 minutes before "now", unhandled -> not yet overdue.
      fixture({ commId: 'fresh', status: 'drafted', ingestedAt: '2026-07-16T12:58:00.000Z' }),
      // Old but answered -> never overdue (handled).
      fixture({
        commId: 'old-but-answered',
        status: 'answered',
        ingestedAt: '2026-07-16T12:00:00.000Z',
      }),
      // Old but dismissed -> never overdue (handled).
      fixture({
        commId: 'old-but-dismissed',
        status: 'dismissed',
        ingestedAt: '2026-07-16T12:00:00.000Z',
      }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
      now: () => new Date('2026-07-16T13:00:00.000Z'),
    });

    const metrics = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });

    expect(metrics.overdueCount).toBe(1);
  });

  it('flips overdue at exactly the 5-minute mark (>5min, not >=)', async () => {
    const exactlyFive = fixture({
      commId: 'exactly-five',
      status: 'drafted',
      ingestedAt: '2026-07-16T12:55:00.000Z',
    });
    const overFive = fixture({
      commId: 'over-five',
      status: 'drafted',
      ingestedAt: '2026-07-16T12:54:59.000Z',
    });
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo([exactlyFive, overFive]),
      accountsRepo: accountsRepo(),
      now: () => new Date('2026-07-16T13:00:00.000Z'),
    });

    const metrics = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });

    // Exactly 5:00 elapsed is NOT overdue yet; 5:01 elapsed IS.
    expect(metrics.overdueCount).toBe(1);
  });

  it('computes response-time (ingested -> answered) duration stats from transition timestamps', async () => {
    const records = [
      fixture({
        commId: 'fast',
        status: 'answered',
        ingestedAt: '2026-07-16T12:00:00.000Z',
        transitions: [
          {
            commId: 'fast',
            accountId: ACCOUNT_A,
            from: 'ingested',
            to: 'recommended',
            actorId: 'system',
            ts: '2026-07-16T12:00:00.000Z',
          },
          {
            commId: 'fast',
            accountId: ACCOUNT_A,
            from: 'sent',
            to: 'answered',
            actorId: USER_A,
            ts: '2026-07-16T12:02:00.000Z', // 2 minutes after the ingested transition
          },
        ],
      }),
      fixture({
        commId: 'slow',
        status: 'answered',
        ingestedAt: '2026-07-16T12:00:00.000Z',
        transitions: [
          {
            commId: 'slow',
            accountId: ACCOUNT_A,
            from: 'sent',
            to: 'answered',
            actorId: USER_A,
            ts: '2026-07-16T12:10:00.000Z', // 10 minutes after ingestedAt (no ingested transition -> falls back to ingestedAt)
          },
        ],
      }),
      // Not yet answered — excluded from response-time stats entirely.
      fixture({ commId: 'pending', status: 'drafted', ingestedAt: '2026-07-16T12:00:00.000Z' }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
      now: () => new Date('2026-07-16T13:00:00.000Z'),
    });

    const metrics = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });

    expect(metrics.responseTime.sampleCount).toBe(2);
    expect(metrics.responseTime.averageSeconds).toBe(360); // (120 + 600) / 2
    expect(metrics.responseTime.medianSeconds).toBeGreaterThan(0);
    expect(metrics.responseTime.underFiveMinutesCount).toBe(1);
  });

  it('returns zeroed metrics (no throw) for an account with no communications yet', async () => {
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo([]),
      accountsRepo: accountsRepo(),
    });

    const metrics = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });

    expect(metrics.totalVolume).toBe(0);
    expect(metrics.overdueCount).toBe(0);
    expect(metrics.pendingApprovalsCount).toBe(0);
    expect(metrics.responseTime.sampleCount).toBe(0);
    expect(metrics.responseTime.averageSeconds).toBeNull();
  });

  it('never includes PII in the metrics payload (no participants/body/rationale fields)', async () => {
    const records = [
      fixture({
        commId: 'pii-check',
        body: 'sensitive body text',
        participants: [{ id: 'someone@example.com', role: 'from' }],
        recommendation: {
          commId: 'pii-check',
          accountId: ACCOUNT_A,
          actionType: 'reply_needed',
          confidence: 0.9,
          rationale: 'contains a sensitive rationale',
        },
      }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });

    const metrics = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });
    const serialized = JSON.stringify(metrics);

    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('sensitive body text');
    expect(serialized).not.toContain('sensitive rationale');
  });
});

describe('MetricsService — per-user permission boundary (account-scoping, server-side)', () => {
  it('rejects a metrics request when userId does not own accountId', async () => {
    const records = [fixture({ commId: 'a', accountId: ACCOUNT_A })];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });

    await expect(
      service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_B }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it("user B's metrics never include user A's account records, and vice versa", async () => {
    const records = [
      fixture({ commId: 'a1', accountId: ACCOUNT_A, status: 'drafted' }),
      fixture({ commId: 'a2', accountId: ACCOUNT_A, status: 'answered' }),
      fixture({ commId: 'b1', accountId: ACCOUNT_B, status: 'drafted' }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });

    const metricsA = await service.getDashboardMetrics({ accountId: ACCOUNT_A, userId: USER_A });
    expect(metricsA.totalVolume).toBe(2);

    const metricsB = await service.getDashboardMetrics({ accountId: ACCOUNT_B, userId: USER_B });
    expect(metricsB.totalVolume).toBe(1);
  });

  it('listRecommendedActions and listDraftsAwaitingApproval also enforce the account guard', async () => {
    const records = [fixture({ commId: 'a', accountId: ACCOUNT_A })];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });

    await expect(
      service.listRecommendedActions({ accountId: ACCOUNT_A, userId: USER_B }),
    ).rejects.toThrow(AccountAccessDeniedError);
    await expect(
      service.listDraftsAwaitingApproval({ accountId: ACCOUNT_A, userId: USER_B }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });
});

describe('MetricsService.listRecommendedActions', () => {
  it('returns only communications carrying a recommendation, most-recent first', async () => {
    const records = [
      fixture({
        commId: 'has-rec-old',
        status: 'drafted',
        ts: '2026-07-16T10:00:00.000Z',
        recommendation: {
          commId: 'has-rec-old',
          accountId: ACCOUNT_A,
          actionType: 'reply_needed',
          confidence: 0.8,
          rationale: 'r1',
        },
      }),
      fixture({ commId: 'no-rec', status: 'ingested' }),
      fixture({
        commId: 'has-rec-new',
        status: 'drafted',
        ts: '2026-07-16T11:00:00.000Z',
        recommendation: {
          commId: 'has-rec-new',
          accountId: ACCOUNT_A,
          actionType: 'schedule',
          confidence: 0.95,
          rationale: 'r2',
        },
      }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });

    const result = await service.listRecommendedActions({ accountId: ACCOUNT_A, userId: USER_A });

    expect(result.map((r) => r.commId)).toEqual(['has-rec-new', 'has-rec-old']);
  });
});

describe('MetricsService.listDraftsAwaitingApproval', () => {
  it('returns only drafted/awaiting_approval communications with a draft body', async () => {
    const records = [
      fixture({
        commId: 'draft-1',
        status: 'drafted',
        draft: { commId: 'draft-1', accountId: ACCOUNT_A, body: 'hi', confidence: 0.8 },
      }),
      fixture({
        commId: 'draft-2',
        status: 'awaiting_approval',
        draft: { commId: 'draft-2', accountId: ACCOUNT_A, body: 'hello', confidence: 0.9 },
      }),
      fixture({ commId: 'no-draft', status: 'needs_context' }),
      fixture({ commId: 'already-answered', status: 'answered' }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });

    const result = await service.listDraftsAwaitingApproval({
      accountId: ACCOUNT_A,
      userId: USER_A,
    });

    expect(result.map((r) => r.commId).sort()).toEqual(['draft-1', 'draft-2']);
  });
});

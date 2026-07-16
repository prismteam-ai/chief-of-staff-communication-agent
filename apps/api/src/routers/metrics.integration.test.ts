import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { createMetricsRouter } from './metrics.js';
import { MetricsService } from '../services/metrics-service.js';
import type { Context } from '../context.js';
import { fakeAuthService, issueBearerToken, FORGED_TOKEN } from '../test-support/fake-auth-service.js';

/**
 * Integration test (Task 8 brief constraint 10, mirroring `communications.integration.test.ts`):
 * drives the ACTUAL tRPC router surface (`createMetricsRouter`) — not just the `MetricsService`
 * unit — via `createCaller`, proving the router -> service -> repo wiring enforces the account
 * guard end to end, not just inside the service class.
 *
 * Task 8.5: `userId` is no longer a client input — every call authenticates via a bearer token
 * (`ctxWithToken`), and `userId` in the assertions below is now IMPLIED by which token was issued,
 * never supplied directly.
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
    async putIngested() {
      throw new Error('not used');
    },
    async transition() {
      throw new Error('not used');
    },
    async claimSend() {
      throw new Error('not used');
    },
    async recordSent() {
      throw new Error('not used');
    },
    async linkAsanaTask() {
      throw new Error('not used');
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

function ctxWithToken(token?: string): Context {
  return { bearerToken: token } as unknown as Context;
}

describe('metrics router integration', () => {
  it('getDashboardMetrics returns account-scoped aggregates through the router', async () => {
    const records = [
      fixture({ commId: 'a1', accountId: ACCOUNT_A, status: 'drafted' }),
      fixture({ commId: 'a2', accountId: ACCOUNT_A, status: 'answered' }),
      fixture({ commId: 'b1', accountId: ACCOUNT_B, status: 'drafted' }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });
    const authService = fakeAuthService();
    const router = createMetricsRouter(() => service, () => authService);
    const token = await issueBearerToken(authService, USER_A);
    const caller = router.createCaller(ctxWithToken(token));

    const metrics = await caller.getDashboardMetrics({ accountId: ACCOUNT_A });
    expect(metrics.totalVolume).toBe(2);
  });

  it('rejects cross-user access at the router boundary for every metrics procedure', async () => {
    const records = [fixture({ commId: 'a1', accountId: ACCOUNT_A })];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });
    const authService = fakeAuthService();
    const router = createMetricsRouter(() => service, () => authService);
    // SECURITY (Task 8.5 brief constraint 7): USER_B's own valid token cannot read ACCOUNT_A's
    // metrics — cross-user denial driven end to end through the router.
    const token = await issueBearerToken(authService, USER_B);
    const caller = router.createCaller(ctxWithToken(token));

    await expect(caller.getDashboardMetrics({ accountId: ACCOUNT_A })).rejects.toThrow();
    await expect(caller.listRecommendedActions({ accountId: ACCOUNT_A })).rejects.toThrow();
    await expect(caller.listDraftsAwaitingApproval({ accountId: ACCOUNT_A })).rejects.toThrow();
  });

  it('listDraftsAwaitingApproval and listRecommendedActions return account-scoped records through the router', async () => {
    const records = [
      fixture({
        commId: 'a-draft',
        accountId: ACCOUNT_A,
        status: 'drafted',
        draft: { commId: 'a-draft', accountId: ACCOUNT_A, body: 'hi', confidence: 0.9 },
        recommendation: {
          commId: 'a-draft',
          accountId: ACCOUNT_A,
          actionType: 'reply_needed',
          confidence: 0.9,
          rationale: 'r',
        },
      }),
      fixture({
        commId: 'b-draft',
        accountId: ACCOUNT_B,
        status: 'drafted',
        draft: { commId: 'b-draft', accountId: ACCOUNT_B, body: 'hi', confidence: 0.9 },
      }),
    ];
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo(records),
      accountsRepo: accountsRepo(),
    });
    const authService = fakeAuthService();
    const router = createMetricsRouter(() => service, () => authService);
    const token = await issueBearerToken(authService, USER_A);
    const caller = router.createCaller(ctxWithToken(token));

    const drafts = await caller.listDraftsAwaitingApproval({ accountId: ACCOUNT_A });
    expect(drafts.map((d) => d.commId)).toEqual(['a-draft']);

    const recommended = await caller.listRecommendedActions({ accountId: ACCOUNT_A });
    expect(recommended.map((r) => r.commId)).toEqual(['a-draft']);
  });

  it('SECURITY: rejects a call with no Authorization header (401)', async () => {
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo([]),
      accountsRepo: accountsRepo(),
    });
    const authService = fakeAuthService();
    const router = createMetricsRouter(() => service, () => authService);
    const caller = router.createCaller(ctxWithToken(undefined));

    await expect(caller.getDashboardMetrics({ accountId: ACCOUNT_A })).rejects.toThrow(TRPCError);
  });

  it('SECURITY: rejects a forged/unknown bearer token (401)', async () => {
    const service = new MetricsService({
      communicationsRepo: inMemoryRepo([]),
      accountsRepo: accountsRepo(),
    });
    const authService = fakeAuthService();
    const router = createMetricsRouter(() => service, () => authService);
    const caller = router.createCaller(ctxWithToken(FORGED_TOKEN));

    await expect(caller.getDashboardMetrics({ accountId: ACCOUNT_A })).rejects.toThrow(TRPCError);
  });
});

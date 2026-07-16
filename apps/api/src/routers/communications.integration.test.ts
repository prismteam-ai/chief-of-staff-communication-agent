import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import { TransitionConflictError, SendAlreadyClaimedError } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import type { Connector } from '@chief-of-staff/connectors';
import { createCommunicationsRouter } from './communications.js';
import { ApprovalService } from '../services/approval-service.js';
import type { AgentTrigger } from '../agent-trigger.js';
import type { Context } from '../context.js';
import {
  fakeAuthService,
  issueBearerToken,
  FORGED_TOKEN,
} from '../test-support/fake-auth-service.js';

/**
 * Integration test (Task 6 brief constraint 7): "approve a fixture drafted communication -> send
 * called (fake gmail) -> answered", driven through the ACTUAL tRPC router surface
 * (`createCommunicationsRouter`) — not just the `ApprovalService` unit — via a `createCaller`-style
 * direct procedure invocation against a built router instance. Repos are in-memory fakes (no AWS);
 * the connector is a fake Gmail `send` that records the exact `OutboundMessage` it was called with,
 * so this also proves the router -> service -> connector wiring produces correct RFC2822 threading
 * inputs end to end, not just that *some* send happened.
 *
 * Task 8.5: every procedure now sits behind `authedMiddleware` — `ctx({ authService })` below
 * builds a router with a real, in-memory-backed `McpAuthService` and every call presents a bearer
 * token via `ctxWithToken`, proving the SAME auth gate `mcp.integration.test.ts` exercises for the
 * MCP surface now guards the dashboard's own procedures too (no more client-supplied `userId`).
 */

const ACCOUNT_ID = 'acct-gmail-demoalex775';
const USER_ID = 'demo-alex';
const COMM_ID = 'gmail#19f6aff00ee81d98';

function fixtureDraftedCommunication(): ApiCommunicationRecord {
  return {
    commId: COMM_ID,
    accountId: ACCOUNT_ID,
    schemaVersion: 1,
    channelType: 'gmail',
    externalId: '19f6aff00ee81d98',
    threadKey: '19f6aff00ee81d98',
    providerMessageIdHeader: '<CAF+reorg-thread-001@mail.gmail.com>',
    participants: [
      { id: 'demoalex775@gmail.com', role: 'from' },
      {
        id: 'renee.castellano@harborline-partners.com',
        displayName: 'Renee Castellano',
        role: 'to',
      },
    ],
    ts: '2026-07-16T12:55:24.000Z',
    subject: 'Reorg heads up — routing intros going forward',
    body: "Hi Renee,\n\nThanks for the heads up on the reorg — I'll route future intros through the new structure.\n\nBest,\nAlex",
    attachments: [],
    status: 'drafted',
    ingestedAt: '2026-07-16T12:56:24.283Z',
    recommendation: {
      commId: COMM_ID,
      accountId: ACCOUNT_ID,
      actionType: 'fyi_no_reply',
      confidence: 0.88,
      rationale: 'Acknowledgment, no question posed.',
    },
    draft: {
      commId: COMM_ID,
      accountId: ACCOUNT_ID,
      body: 'Thanks for confirming, Alex — noted. No further action needed on your end.\n\nBest,\nRenee',
      confidence: 0.72,
    },
    transitions: [
      {
        commId: COMM_ID,
        accountId: ACCOUNT_ID,
        from: 'ingested',
        to: 'recommended',
        actorId: 'system',
        ts: '2026-07-16T15:44:10.079Z',
      },
      {
        commId: COMM_ID,
        accountId: ACCOUNT_ID,
        from: 'recommended',
        to: 'drafted',
        actorId: 'system',
        ts: '2026-07-16T15:44:10.080Z',
      },
    ],
  };
}

function inMemoryCommunicationsRepo(
  seed: ApiCommunicationRecord,
): CommunicationsRepo & { current: () => ApiCommunicationRecord } {
  let record = { ...seed };
  return {
    current: () => record,
    async getById(commId) {
      return commId === record.commId ? { ...record } : undefined;
    },
    async listByAccount(accountId, status) {
      if (record.accountId !== accountId) return [];
      if (status && record.status !== status) return [];
      return [{ ...record }];
    },
    async putIngested() {
      throw new Error('not used in communications integration tests');
    },
    async transition(t, patch) {
      if (record.status !== t.from) throw new TransitionConflictError(t.commId, t.from);
      record = {
        ...record,
        status: t.to,
        transitions: [...(record.transitions ?? []), t],
        ...(patch?.draft ? { draft: patch.draft } : {}),
      };
    },
    async claimSend(commId) {
      if (record.sendClaimedAt) throw new SendAlreadyClaimedError(commId);
      record = { ...record, sendClaimedAt: '2026-07-16T18:00:00.000Z' };
    },
    async recordSent(commId, sentMessageId) {
      record = { ...record, sentMessageId };
    },
    async linkAsanaTask(commId, taskGid, permalink) {
      record = { ...record, asanaTaskGid: taskGid, asanaTaskPermalink: permalink };
    },
  };
}

function noopAgentTrigger(): AgentTrigger {
  return { publish: async () => {} };
}

function inMemoryAccountsRepo(): AccountsRepo {
  return {
    async getOwner(accountId) {
      return accountId === ACCOUNT_ID ? USER_ID : undefined;
    },
    async getOwnAddress(accountId) {
      return accountId === ACCOUNT_ID ? 'demoalex775@gmail.com' : undefined;
    },
    async listByUser() {
      return [];
    },
  };
}

function ctxWithToken(token?: string): Context {
  return { bearerToken: token } as unknown as Context;
}

describe('communications router integration — approve -> send -> answered', () => {
  it('drives approveDraft through the router, calling the fake Gmail connector with correctly threaded fields', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
    const sentPayloads: unknown[] = [];

    const fakeGmailConnector: Connector = {
      channelType: 'gmail',
      async ingest() {
        return [];
      },
      async identity(_id, accountId) {
        return { accountId };
      },
      async send(message) {
        sentPayloads.push(message);
        return { providerMessageId: 'gmail-sent-live-1' };
      },
    };

    const service = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      connectorFor: () => fakeGmailConnector,
      agentTrigger: noopAgentTrigger(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
      now: () => new Date('2026-07-16T18:00:00.000Z'),
    });

    const authService = fakeAuthService();
    const router = createCommunicationsRouter(
      () => service,
      () => authService,
    );
    const token = await issueBearerToken(authService, USER_ID);

    const result = await router.createCaller(ctxWithToken(token)).approveDraft({ commId: COMM_ID });

    expect(result.status).toBe('answered');
    expect(result.sentMessageId).toBe('gmail-sent-live-1');
    expect(repo.current().status).toBe('answered');

    expect(sentPayloads).toHaveLength(1);
    const sent = sentPayloads[0] as {
      accountId: string;
      threadKey: string;
      inReplyToExternalId?: string;
      inReplyToMessageId?: string;
      subject?: string;
      to: string[];
      body: string;
    };
    expect(sent.accountId).toBe(ACCOUNT_ID);
    expect(sent.threadKey).toBe('19f6aff00ee81d98');
    expect(sent.inReplyToExternalId).toBe('19f6aff00ee81d98');
    expect(sent.inReplyToMessageId).toBe('<CAF+reorg-thread-001@mail.gmail.com>');
    // Task 6 review fix: the captured subject reaches connector.send end to end through the router.
    expect(sent.subject).toBe('Reorg heads up — routing intros going forward');
    expect(sent.to).toEqual(['renee.castellano@harborline-partners.com']);
    expect(sent.body).toContain('Thanks for confirming, Alex');
  });

  it('a second approveDraft call on the now-answered communication does not call send again (idempotency, router-level)', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
    let sendCallCount = 0;

    const fakeGmailConnector: Connector = {
      channelType: 'gmail',
      async ingest() {
        return [];
      },
      async identity(_id, accountId) {
        return { accountId };
      },
      async send() {
        sendCallCount += 1;
        return { providerMessageId: `gmail-sent-${sendCallCount}` };
      },
    };

    const service = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      connectorFor: () => fakeGmailConnector,
      agentTrigger: noopAgentTrigger(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
      now: () => new Date('2026-07-16T18:00:00.000Z'),
    });

    const authService = fakeAuthService();
    const router = createCommunicationsRouter(
      () => service,
      () => authService,
    );
    const token = await issueBearerToken(authService, USER_ID);
    const caller = router.createCaller(ctxWithToken(token));

    await caller.approveDraft({ commId: COMM_ID });
    expect(sendCallCount).toBe(1);
    expect(repo.current().status).toBe('answered');

    await expect(caller.approveDraft({ commId: COMM_ID })).rejects.toThrow();
    expect(sendCallCount).toBe(1);
  });

  it('rejects cross-user access at the router boundary (account guard, end to end)', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
    const service = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      connectorFor: () => undefined,
      agentTrigger: noopAgentTrigger(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const authService = fakeAuthService();
    const router = createCommunicationsRouter(
      () => service,
      () => authService,
    );
    // SECURITY (Task 8.5 brief constraint 7): a token issued for a real but non-owning user cannot
    // read/act on another user's communication — cross-user denial, driven end to end through the
    // router, not just the service's own ownership check.
    const token = await issueBearerToken(authService, 'not-the-owner');
    const caller = router.createCaller(ctxWithToken(token));

    await expect(caller.approveDraft({ commId: COMM_ID })).rejects.toThrow();
    expect(repo.current().status).toBe('drafted');
  });

  it('SECURITY: rejects a call with no Authorization header (401)', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
    const service = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      connectorFor: () => undefined,
      agentTrigger: noopAgentTrigger(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const authService = fakeAuthService();
    const router = createCommunicationsRouter(
      () => service,
      () => authService,
    );
    const caller = router.createCaller(ctxWithToken(undefined));

    await expect(caller.listCommunications({ accountId: ACCOUNT_ID })).rejects.toThrow(TRPCError);
    await expect(caller.approveDraft({ commId: COMM_ID })).rejects.toThrow(TRPCError);
  });

  it('SECURITY: rejects a forged/unknown bearer token (401)', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
    const service = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      connectorFor: () => undefined,
      agentTrigger: noopAgentTrigger(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const authService = fakeAuthService();
    const router = createCommunicationsRouter(
      () => service,
      () => authService,
    );
    const caller = router.createCaller(ctxWithToken(FORGED_TOKEN));

    await expect(caller.approveDraft({ commId: COMM_ID })).rejects.toThrow(TRPCError);
    expect(repo.current().status).toBe('drafted');
  });

  it('client can no longer inject userId — it is not part of the input schema', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
    const fakeGmailConnector: Connector = {
      channelType: 'gmail',
      async ingest() {
        return [];
      },
      async identity(_id, accountId) {
        return { accountId };
      },
      async send() {
        return { providerMessageId: 'gmail-sent-no-inject-1' };
      },
    };
    const service = new ApprovalService({
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      connectorFor: () => fakeGmailConnector,
      agentTrigger: noopAgentTrigger(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const authService = fakeAuthService();
    const router = createCommunicationsRouter(
      () => service,
      () => authService,
    );
    const token = await issueBearerToken(authService, USER_ID);
    const caller = router.createCaller(ctxWithToken(token));

    // A client-supplied `userId` alongside `commId` is simply stripped by zod (not part of the
    // schema) — the call still succeeds, scoped by the TOKEN's userId, proving the field has no
    // effect whatsoever on which identity the call acts as.
    const result = await caller.approveDraft({
      commId: COMM_ID,
      // @ts-expect-error -- userId is intentionally not part of the input schema anymore
      userId: 'someone-else-entirely',
    });
    expect(result.status).toBe('answered');
  });
});

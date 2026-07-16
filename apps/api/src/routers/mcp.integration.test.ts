import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { McpTokenInvalidError, type Recommendation, type Draft } from '@chief-of-staff/shared';
import type { RetrievalIndex, SearchHit } from '@chief-of-staff/rag';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import { TransitionConflictError, SendAlreadyClaimedError } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import type { Connector } from '@chief-of-staff/connectors';
import type { AsanaClient } from '@chief-of-staff/connectors/asana';
import { createMcpRouter } from './mcp.js';
import { ApprovalService } from '../services/approval-service.js';
import { AsanaService } from '../services/asana-service.js';
import { McpAuthService } from '../services/mcp-auth-service.js';
import type { AgentTrigger } from '../agent-trigger.js';
import type { Context } from '../context.js';

/**
 * Integration test for the MCP-facing tRPC router (Task 11, brief constraint 7): drives the ACTUAL
 * router surface — token issuance, every tool procedure resolving `userId` from the verified
 * token, and the SECURITY property a forged/other-user token can never widen access. Repos/
 * connectors are in-memory fakes (no AWS), same style as `communications.integration.test.ts`.
 */

const ACCOUNT_ALEX = 'acct-gmail-demoalex775';
const ACCOUNT_BLAKE = 'acct-gmail-demoblake';
const USER_ALEX = 'demo-alex';
const USER_BLAKE = 'demo-blake';
const COMM_ID = 'gmail#19f6aff00ee81d98';

function fixtureDraftedCommunication(): ApiCommunicationRecord {
  const recommendation: Recommendation = {
    commId: COMM_ID,
    accountId: ACCOUNT_ALEX,
    actionType: 'fyi_no_reply',
    confidence: 0.88,
    rationale: 'Acknowledgment, no question posed.',
  };
  const draft: Draft = {
    commId: COMM_ID,
    accountId: ACCOUNT_ALEX,
    body: 'Thanks for confirming — noted. No further action needed on your end.',
    confidence: 0.72,
  };
  return {
    commId: COMM_ID,
    accountId: ACCOUNT_ALEX,
    schemaVersion: 1,
    channelType: 'gmail',
    externalId: '19f6aff00ee81d98',
    threadKey: '19f6aff00ee81d98',
    providerMessageIdHeader: '<CAF+mcp-thread-001@mail.gmail.com>',
    participants: [
      { id: 'demoalex775@gmail.com', role: 'from' },
      { id: 'renee.castellano@harborline-partners.com', displayName: 'Renee', role: 'to' },
    ],
    ts: '2026-07-16T12:55:24.000Z',
    subject: 'Reorg heads up',
    body: 'Thanks for the heads up on the reorg.',
    attachments: [],
    status: 'drafted',
    ingestedAt: '2026-07-16T12:56:24.283Z',
    recommendation,
    draft,
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
      throw new Error('not used in mcp integration tests');
    },
    async transition(t, patch) {
      if (record.status !== t.from) throw new TransitionConflictError(t.commId, t.from);
      record = {
        ...record,
        status: t.to,
        transitions: [...(record.transitions ?? []), t],
        ...(patch?.draft ? { draft: patch.draft } : {}),
        ...(patch?.appendSuppliedContext
          ? { suppliedContext: [...(record.suppliedContext ?? []), patch.appendSuppliedContext] }
          : {}),
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

function inMemoryAccountsRepo(): AccountsRepo {
  return {
    async getOwner(accountId) {
      if (accountId === ACCOUNT_ALEX) return USER_ALEX;
      if (accountId === ACCOUNT_BLAKE) return USER_BLAKE;
      return undefined;
    },
    async getOwnAddress(accountId) {
      return accountId === ACCOUNT_ALEX ? 'demoalex775@gmail.com' : undefined;
    },
    async listByUser() {
      return [];
    },
  };
}

function noopAgentTrigger(): AgentTrigger {
  return { publish: async () => {} };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function fakeMetrics() {
  return { addMetric: vi.fn() };
}

function buildRouterHarness(opts?: { sendCalls?: unknown[]; asanaCreateCalls?: unknown[] }) {
  const communicationsRepo = inMemoryCommunicationsRepo(fixtureDraftedCommunication());
  const accountsRepo = inMemoryAccountsRepo();

  const fakeGmailConnector: Connector = {
    channelType: 'gmail',
    async ingest() {
      return [];
    },
    async identity(_id, accountId) {
      return { accountId };
    },
    async send(message) {
      opts?.sendCalls?.push(message);
      return { providerMessageId: 'gmail-sent-mcp-1' };
    },
  };

  const approvalService = new ApprovalService({
    communicationsRepo,
    accountsRepo,
    connectorFor: () => fakeGmailConnector,
    agentTrigger: noopAgentTrigger(),
    log: fakeLogger(),
    metricsClient: fakeMetrics(),
    now: () => new Date('2026-07-16T18:00:00.000Z'),
  });

  const fakeAsanaClient: Pick<AsanaClient, 'createTask' | 'linkToCommunication' | 'projectGid'> = {
    async createTask(input) {
      opts?.asanaCreateCalls?.push(input);
      return {
        gid: 'asana-task-1',
        name: input.name,
        notes: input.notes ?? '',
        completed: false,
        permalink_url: 'https://app.asana.com/0/1/asana-task-1',
        due_on: input.dueOn ?? null,
        projects: [{ gid: 'project-gid-1', name: 'CoS Agent' }],
      };
    },
    async linkToCommunication() {
      throw new Error('not exercised in this test');
    },
    async projectGid() {
      return 'project-gid-1';
    },
  };

  const asanaService = new AsanaService({
    asanaClient: fakeAsanaClient as unknown as AsanaClient,
    communicationsRepo,
    accountsRepo,
    log: fakeLogger(),
    metricsClient: fakeMetrics(),
  });

  const authService = new McpAuthService({
    tokensRepo: (() => {
      const store = new Map<
        string,
        { tokenHash: string; userId: string; label: string; createdAt: string }
      >();
      return {
        async put(record) {
          store.set(record.tokenHash, record);
        },
        async getByHash(hash) {
          return store.get(hash);
        },
        async touchLastUsed() {},
      };
    })(),
    log: fakeLogger(),
    metricsClient: fakeMetrics(),
  });

  const fakeSearchHit: SearchHit = {
    chunkId: 'chunk-1',
    sourceId: COMM_ID,
    textForContext: 'Reorg heads up context',
    score: 0.91,
    metadata: { channel: 'gmail', sourceType: 'communication' } as SearchHit['metadata'],
  };
  const retrievalIndex: RetrievalIndex = {
    async indexChunks() {},
    async search(_embedding, _query, options) {
      // Account-scoping proof: only ever returns hits for ACCOUNT_ALEX's own scope.
      return options.accountId === ACCOUNT_ALEX ? [fakeSearchHit] : [];
    },
    async filterSearch() {
      return [];
    },
  };

  const router = createMcpRouter({
    authService: () => authService,
    approvalService: () => approvalService,
    asanaService: () => asanaService,
    accountsRepo: () => accountsRepo,
    retrievalIndex: () => retrievalIndex,
    // Never calls Bedrock in tests — the fake retrievalIndex above ignores the embedding's actual
    // values and only asserts on `options.accountId`.
    embed: async () => [0.1, 0.2, 0.3],
  });

  return { router, communicationsRepo, authService };
}

function ctxWithToken(token?: string): Context {
  return { mcpBearerToken: token } as unknown as Context;
}

describe('mcp router — issueMcpToken', () => {
  it('mints a token usable to authenticate subsequent calls', async () => {
    const { router, authService } = buildRouterHarness();
    const caller = router.createCaller(ctxWithToken());

    const issued = await caller.issueMcpToken({ userId: USER_ALEX, label: 'Cursor desktop' });

    expect(issued.userId).toBe(USER_ALEX);
    await expect(authService.verify(issued.token)).resolves.toBe(USER_ALEX);
  });
});

describe('mcp router — authentication gate', () => {
  it('rejects a call with no Authorization header', async () => {
    const { router } = buildRouterHarness();
    const caller = router.createCaller(ctxWithToken(undefined));

    await expect(caller.recommendAction({ commId: COMM_ID })).rejects.toThrow(TRPCError);
  });

  it('SECURITY: rejects a forged/unknown bearer token', async () => {
    const { router } = buildRouterHarness();
    const caller = router.createCaller(ctxWithToken('cos_mcp_' + 'a'.repeat(64)));

    await expect(caller.recommendAction({ commId: COMM_ID })).rejects.toThrow(TRPCError);
  });
});

describe('mcp router — token-resolved userId scopes every call (never client-supplied)', () => {
  it("recommendAction/draftReply return the agent's already-produced work product for the token's own account", async () => {
    const { router, authService } = buildRouterHarness();
    const issued = await authService.issue({ userId: USER_ALEX, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(issued.token));

    const recommendation = await caller.recommendAction({ commId: COMM_ID });
    expect(recommendation.recommendation?.actionType).toBe('fyi_no_reply');

    const draft = await caller.draftReply({ commId: COMM_ID });
    expect(draft.draft?.body).toContain('Thanks for confirming');
  });

  it('SECURITY: a token issued for user B cannot read user A-owned communication data', async () => {
    const { router, authService } = buildRouterHarness();
    const blakeToken = await authService.issue({ userId: USER_BLAKE, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(blakeToken.token));

    // COMM_ID belongs to ACCOUNT_ALEX, owned by USER_ALEX — Blake's token must not read it, even
    // though Blake supplies no accountId at all (recommendAction/draftReply take only commId).
    await expect(caller.recommendAction({ commId: COMM_ID })).rejects.toThrow();
  });

  it('SECURITY: retrieveContext is scoped by the token-resolved userId, not a client-asserted one', async () => {
    const { router, authService } = buildRouterHarness();
    const blakeToken = await authService.issue({ userId: USER_BLAKE, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(blakeToken.token));

    // Blake's token cannot retrieve context scoped to Alex's account, even by explicitly asking.
    await expect(
      caller.retrieveContext({ accountId: ACCOUNT_ALEX, query: 'reorg' }),
    ).rejects.toThrow();
  });

  it('retrieveContext returns real hits for the caller’s own account', async () => {
    const { router, authService } = buildRouterHarness();
    const alexToken = await authService.issue({ userId: USER_ALEX, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(alexToken.token));

    const result = await caller.retrieveContext({ accountId: ACCOUNT_ALEX, query: 'reorg' });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.sourceId).toBe(COMM_ID);
  });
});

describe('mcp router — writes are real executions behind the confirm-gated MCP tool description', () => {
  it('approveDraft executes the send exactly once the router procedure is called (router itself never auto-invokes)', async () => {
    const sendCalls: unknown[] = [];
    const { router, authService, communicationsRepo } = buildRouterHarness({ sendCalls });
    const alexToken = await authService.issue({ userId: USER_ALEX, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(alexToken.token));

    // The record starts drafted and stays drafted until this procedure is explicitly called —
    // proving nothing auto-executes merely from issuing a token or calling read procedures.
    expect(communicationsRepo.current().status).toBe('drafted');

    const result = await caller.approveDraft({ commId: COMM_ID });

    expect(result.status).toBe('answered');
    expect(sendCalls).toHaveLength(1);
  });

  it('manageAsanaCreate performs the real Asana write when explicitly invoked', async () => {
    const asanaCreateCalls: unknown[] = [];
    const { router, authService } = buildRouterHarness({ asanaCreateCalls });
    const alexToken = await authService.issue({ userId: USER_ALEX, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(alexToken.token));

    const result = await caller.manageAsanaCreate({ commId: COMM_ID, title: 'Follow up' });

    expect(result.asanaTaskGid).toBe('asana-task-1');
    expect(asanaCreateCalls).toHaveLength(1);
  });

  it('SECURITY: user B token cannot approve or write against user A’s communication', async () => {
    const { router, authService } = buildRouterHarness();
    const blakeToken = await authService.issue({ userId: USER_BLAKE, label: 'Cursor' });
    const caller = router.createCaller(ctxWithToken(blakeToken.token));

    await expect(caller.approveDraft({ commId: COMM_ID })).rejects.toThrow();
    await expect(
      caller.manageAsanaCreate({ commId: COMM_ID, title: 'Should not be created' }),
    ).rejects.toThrow();
  });
});

describe('mcp router — McpTokenInvalidError maps to TRPCError UNAUTHORIZED', () => {
  it('is thrown by the auth middleware, not swallowed', async () => {
    const { router } = buildRouterHarness();
    const caller = router.createCaller(ctxWithToken('not-a-real-token'));

    try {
      await caller.recommendAction({ commId: COMM_ID });
      expect.fail('expected a TRPCError');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('UNAUTHORIZED');
      expect((error as TRPCError).message).toBe(new McpTokenInvalidError().message);
    }
  });
});

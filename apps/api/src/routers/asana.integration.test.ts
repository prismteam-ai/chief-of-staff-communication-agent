import { describe, expect, it, vi } from 'vitest';
import {
  ScopeViolationError,
  type AsanaClient,
  type AsanaTask,
} from '@chief-of-staff/connectors/asana';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { createAsanaRouter } from './asana.js';
import { AsanaService } from '../services/asana-service.js';
import type { Context } from '../context.js';

/**
 * Integration test (mirrors `communications.integration.test.ts`'s pattern for Task 6): drives the
 * ACTUAL tRPC router surface (`createAsanaRouter`) via `createCaller`, not just the `AsanaService`
 * unit — proves the router → service → (fake) Asana client wiring end to end, and that the
 * account-permission guard is enforced at the router boundary the dashboard/MCP will actually call.
 */

const ACCOUNT_ID = 'acct-gmail-demoalex775';
const USER_ID = 'demo-alex';
const OTHER_USER_ID = 'someone-else';
const COMM_ID = 'gmail#19f6aff00ee81d98';
const PROJECT_GID = '1216652353711401';

function fixtureRecord(): ApiCommunicationRecord {
  return {
    commId: COMM_ID,
    accountId: ACCOUNT_ID,
    schemaVersion: 1,
    channelType: 'gmail',
    externalId: '19f6aff00ee81d98',
    threadKey: '19f6aff00ee81d98',
    subject: 'Reorg heads up — routing intros going forward',
    participants: [
      { id: 'demoalex775@gmail.com', displayName: 'Alex', role: 'from' },
      { id: 'renee.castellano@harborline-partners.com', displayName: 'Renee', role: 'to' },
    ],
    ts: '2026-07-16T12:55:24.000Z',
    body: 'Full private body.',
    attachments: [],
    status: 'drafted',
    ingestedAt: '2026-07-16T12:56:24.283Z',
    transitions: [],
  };
}

function inMemoryCommunicationsRepo(
  initial: ApiCommunicationRecord,
): CommunicationsRepo & { current: () => ApiCommunicationRecord } {
  let record = { ...initial };
  return {
    current: () => record,
    async getById(commId) {
      return commId === record.commId ? { ...record } : undefined;
    },
    async listByAccount(accountId) {
      return record.accountId === accountId ? [{ ...record }] : [];
    },
    async transition() {},
    async claimSend() {},
    async recordSent() {},
    async linkAsanaTask(commId, taskGid, permalink) {
      record = { ...record, asanaTaskGid: taskGid, asanaTaskPermalink: permalink };
    },
  };
}

function inMemoryAccountsRepo(): AccountsRepo {
  return {
    async getOwner(accountId) {
      return accountId === ACCOUNT_ID ? USER_ID : undefined;
    },
    async getOwnAddress(accountId) {
      return accountId === ACCOUNT_ID ? 'demoalex775@gmail.com' : undefined;
    },
  };
}

function fakeAsanaClient(): Pick<AsanaClient, 'createTask' | 'linkToCommunication' | 'projectGid'> {
  return {
    async projectGid() {
      return PROJECT_GID;
    },
    async createTask(input) {
      const task: AsanaTask = {
        gid: 'new-task-1',
        name: input.name,
        notes: input.notes ?? '',
        completed: false,
        permalink_url: `https://app.asana.com/0/${PROJECT_GID}/new-task-1`,
        projects: [{ gid: PROJECT_GID }],
      };
      return task;
    },
    async linkToCommunication(taskGid) {
      const task: AsanaTask = {
        gid: taskGid,
        name: 'Existing task',
        notes: '',
        completed: false,
        permalink_url: `https://app.asana.com/0/${PROJECT_GID}/${taskGid}`,
        projects: [{ gid: PROJECT_GID }],
      };
      return task;
    },
  };
}

/** A second fake, used only by the out-of-project rejection test: simulates the real
 * `AsanaClient.linkToCommunication`'s membership guard by always throwing `ScopeViolationError`,
 * proving the router/service propagate the rejection rather than swallowing or persisting it. */
function scopeViolatingAsanaClient(): Pick<
  AsanaClient,
  'createTask' | 'linkToCommunication' | 'projectGid'
> {
  return {
    async projectGid() {
      return PROJECT_GID;
    },
    async createTask(input) {
      const task: AsanaTask = {
        gid: 'new-task-1',
        name: input.name,
        notes: input.notes ?? '',
        completed: false,
        permalink_url: `https://app.asana.com/0/${PROJECT_GID}/new-task-1`,
        projects: [{ gid: PROJECT_GID }],
      };
      return task;
    },
    async linkToCommunication(taskGid) {
      throw new ScopeViolationError(taskGid, PROJECT_GID);
    },
  };
}

describe('asana router integration — createAsanaFollowup / linkAsana', () => {
  it('drives createAsanaFollowup through the router, persisting the gid on the communication record', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureRecord());
    const service = new AsanaService({
      asanaClient: fakeAsanaClient() as unknown as AsanaClient,
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const router = createAsanaRouter(() => service);
    const ctx = {} as Context;

    const result = await router.createCaller(ctx).createAsanaFollowup({
      commId: COMM_ID,
      userId: USER_ID,
      title: 'Follow up on reorg intros',
    });

    expect(result.asanaTaskGid).toBe('new-task-1');
    expect(repo.current().asanaTaskGid).toBe('new-task-1');
  });

  it('drives linkAsana through the router, persisting gid + permalink', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureRecord());
    const service = new AsanaService({
      asanaClient: fakeAsanaClient() as unknown as AsanaClient,
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const router = createAsanaRouter(() => service);
    const ctx = {} as Context;

    const result = await router
      .createCaller(ctx)
      .linkAsana({ commId: COMM_ID, userId: USER_ID, taskGid: 'task-existing-42' });

    expect(result.asanaTaskGid).toBe('task-existing-42');
    expect(repo.current().asanaTaskPermalink).toContain('task-existing-42');
  });

  it('rejects createAsanaFollowup for a user who does not own the account, through the router', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureRecord());
    const service = new AsanaService({
      asanaClient: fakeAsanaClient() as unknown as AsanaClient,
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const router = createAsanaRouter(() => service);
    const ctx = {} as Context;

    // tRPC wraps the thrown domain error in a TRPCError — assert on the propagated message (the
    // same pattern the account guard's own unit tests assert the underlying error type directly;
    // this integration test proves the router boundary doesn't swallow or mask the denial).
    await expect(
      router
        .createCaller(ctx)
        .createAsanaFollowup({ commId: COMM_ID, userId: OTHER_USER_ID, title: 'Follow up' }),
    ).rejects.toThrow(/does not have access to account/);
    expect(repo.current().asanaTaskGid).toBeUndefined();
  });

  it('rejects linkAsana for an out-of-project taskGid through the router, persisting nothing', async () => {
    const repo = inMemoryCommunicationsRepo(fixtureRecord());
    const service = new AsanaService({
      asanaClient: scopeViolatingAsanaClient() as unknown as AsanaClient,
      communicationsRepo: repo,
      accountsRepo: inMemoryAccountsRepo(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });

    const router = createAsanaRouter(() => service);
    const ctx = {} as Context;

    await expect(
      router
        .createCaller(ctx)
        .linkAsana({ commId: COMM_ID, userId: USER_ID, taskGid: 'other-project-task-1' }),
    ).rejects.toThrow(/not a member of the configured project/);
    expect(repo.current().asanaTaskGid).toBeUndefined();
  });
});

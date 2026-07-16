import { describe, expect, it, vi } from 'vitest';
import { AccountAccessDeniedError } from '@chief-of-staff/shared';
import type { AsanaClient, AsanaProject, AsanaTask } from '@chief-of-staff/connectors/asana';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import { TransitionConflictError, SendAlreadyClaimedError } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { AsanaService, CommunicationNotFoundError } from './asana-service.js';

/**
 * `AsanaService` unit tests (Task 7 brief `Tests`: "createAsanaFollowup/linkAsana account-guarded+
 * approval-gated"). The `AsanaClient` is a hand-rolled fake here (not `packages/connectors`'s real
 * HTTP client) — this suite proves the SERVICE's account guard, provenance-note composition, and
 * communication-record linking, not the client's HTTP/retry behavior (that is
 * `packages/connectors/src/asana/asana-client.test.ts`'s job).
 */

const ACCOUNT_ID = 'acct-gmail-demoalex775';
const OWNER_USER_ID = 'demo-alex';
const OTHER_USER_ID = 'someone-else';
const COMM_ID = 'gmail#19f6aff00ee81d98';
const PROJECT_GID = '1216652353711401';

function fixtureRecord(overrides: Partial<ApiCommunicationRecord> = {}): ApiCommunicationRecord {
  return {
    commId: COMM_ID,
    accountId: ACCOUNT_ID,
    schemaVersion: 1,
    channelType: 'gmail',
    externalId: '19f6aff00ee81d98',
    threadKey: '19f6aff00ee81d98',
    subject: 'Q3 budget follow-up',
    participants: [
      { id: 'demoalex775@gmail.com', displayName: 'Alex', role: 'to' },
      { id: 'renee.castellano@harborline-partners.com', displayName: 'Renee', role: 'from' },
    ],
    ts: '2026-07-16T12:55:24.000Z',
    body: 'Full private message body that must never reach Asana.',
    attachments: [],
    status: 'drafted',
    ingestedAt: '2026-07-16T12:56:24.283Z',
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
    async transition(record) {
      if (state.record.status !== record.from) {
        throw new TransitionConflictError(record.commId, record.from);
      }
      state.record = { ...state.record, status: record.to };
    },
    async claimSend(commId, priorClaimedAt) {
      const isRetry = priorClaimedAt !== undefined;
      const casOk = isRetry
        ? state.record.sendClaimedAt === priorClaimedAt && !state.record.sentMessageId
        : !state.record.sendClaimedAt;
      if (!casOk) throw new SendAlreadyClaimedError(commId);
      state.record = { ...state.record, sendClaimedAt: '2026-07-16T18:00:00.000Z' };
    },
    async recordSent(commId, sentMessageId) {
      state.record = { ...state.record, sentMessageId };
    },
    async linkAsanaTask(commId, taskGid, permalink) {
      state.record = { ...state.record, asanaTaskGid: taskGid, asanaTaskPermalink: permalink };
    },
  };
}

function fakeAccountsRepo(ownership: Record<string, string>): AccountsRepo {
  return {
    async getOwner(accountId) {
      return ownership[accountId];
    },
    async getOwnAddress() {
      return 'demoalex775@gmail.com';
    },
  };
}

interface FakeAsanaClient extends Pick<
  AsanaClient,
  'createTask' | 'linkToCommunication' | 'listProjects'
> {
  createTaskCalls: Parameters<AsanaClient['createTask']>[0][];
  linkCalls: { taskGid: string; provenance: Parameters<AsanaClient['linkToCommunication']>[1] }[];
}

function fakeAsanaClient(overrides: Partial<FakeAsanaClient> = {}): FakeAsanaClient {
  const createTaskCalls: Parameters<AsanaClient['createTask']>[0][] = [];
  const linkCalls: {
    taskGid: string;
    provenance: Parameters<AsanaClient['linkToCommunication']>[1];
  }[] = [];
  return {
    createTaskCalls,
    linkCalls,
    async createTask(input) {
      createTaskCalls.push(input);
      const task: AsanaTask = {
        gid: 'new-task-1',
        name: input.name,
        notes: input.notes ?? '',
        completed: false,
        permalink_url: `https://app.asana.com/0/${PROJECT_GID}/new-task-1`,
        projects: [{ gid: PROJECT_GID, name: 'CoS Communication Agent' }],
      };
      return task;
    },
    async linkToCommunication(taskGid, provenance) {
      linkCalls.push({ taskGid, provenance });
      const task: AsanaTask = {
        gid: taskGid,
        name: 'Existing task',
        notes: '',
        completed: false,
        permalink_url: `https://app.asana.com/0/${PROJECT_GID}/${taskGid}`,
        projects: [{ gid: PROJECT_GID, name: 'CoS Communication Agent' }],
      };
      return task;
    },
    async listProjects() {
      const projects: AsanaProject[] = [{ gid: PROJECT_GID, name: 'CoS Communication Agent' }];
      return projects;
    },
    ...overrides,
  };
}

function makeService(
  record: ApiCommunicationRecord,
  opts: { ownership?: Record<string, string>; asanaClient?: FakeAsanaClient } = {},
) {
  const repo = fakeCommunicationsRepo(record);
  const accountsRepo = fakeAccountsRepo(opts.ownership ?? { [ACCOUNT_ID]: OWNER_USER_ID });
  const asanaClient = opts.asanaClient ?? fakeAsanaClient();
  const metricsClient = { addMetric: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const service = new AsanaService({
    asanaClient: asanaClient as unknown as AsanaClient,
    communicationsRepo: repo,
    accountsRepo,
    log,
    metricsClient,
  });

  return { service, repo, asanaClient, metricsClient, log };
}

describe('AsanaService — account permission guard', () => {
  it('createAsanaFollowup denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord(), {
      ownership: { [ACCOUNT_ID]: OWNER_USER_ID },
    });
    await expect(
      service.createAsanaFollowup({ commId: COMM_ID, userId: OTHER_USER_ID, title: 'Follow up' }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it('linkAsana denies a user who does not own the account', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(
      service.linkAsana({ commId: COMM_ID, userId: OTHER_USER_ID, taskGid: 'task-99' }),
    ).rejects.toThrow(AccountAccessDeniedError);
  });

  it('createAsanaFollowup throws CommunicationNotFoundError for an unknown commId', async () => {
    const { service } = makeService(fixtureRecord());
    await expect(
      service.createAsanaFollowup({
        commId: 'gmail#does-not-exist',
        userId: OWNER_USER_ID,
        title: 'x',
      }),
    ).rejects.toThrow(CommunicationNotFoundError);
  });

  it('never calls the Asana client before the account guard passes', async () => {
    const { service, asanaClient } = makeService(fixtureRecord());
    await expect(
      service.createAsanaFollowup({ commId: COMM_ID, userId: OTHER_USER_ID, title: 'Follow up' }),
    ).rejects.toThrow(AccountAccessDeniedError);
    expect(asanaClient.createTaskCalls).toHaveLength(0);
  });
});

describe('AsanaService — createAsanaFollowup', () => {
  it('creates the task and persists gid+permalink on the communication record', async () => {
    const { service, repo } = makeService(fixtureRecord());
    const result = await service.createAsanaFollowup({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      title: 'Follow up on Q3 budget',
      dueOn: '2026-07-20',
    });

    expect(result.asanaTaskGid).toBe('new-task-1');
    expect(result.asanaTaskPermalink).toContain('new-task-1');
    expect(repo.record.asanaTaskGid).toBe('new-task-1');
  });

  it('the task notes carry provenance (channel/thread/timestamp/sender/subject) but never the full body', async () => {
    const { service, asanaClient } = makeService(fixtureRecord());
    await service.createAsanaFollowup({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      title: 'Follow up',
    });

    const call = asanaClient.createTaskCalls[0]!;
    expect(call.notes).toContain(COMM_ID);
    expect(call.notes).toContain('gmail');
    expect(call.notes).toContain('Renee');
    expect(call.notes).toContain('Q3 budget follow-up');
    expect(call.notes).not.toContain('Full private message body');
  });

  it('prepends human-supplied notes before the provenance block', async () => {
    const { service, asanaClient } = makeService(fixtureRecord());
    await service.createAsanaFollowup({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      title: 'Follow up',
      notes: 'Reminder: confirm budget number with finance.',
    });

    const notes = asanaClient.createTaskCalls[0]!.notes ?? '';
    expect(notes).toContain('Reminder: confirm budget number with finance.');
    expect(notes.indexOf('Reminder:')).toBeLessThan(notes.indexOf(COMM_ID));
  });

  it('emits AsanaTaskCreated and never AsanaApiFailed on success', async () => {
    const { service, metricsClient } = makeService(fixtureRecord());
    await service.createAsanaFollowup({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      title: 'Follow up',
    });

    expect(metricsClient.addMetric).toHaveBeenCalledWith('AsanaTaskCreated', 'Count', 1);
    expect(metricsClient.addMetric).not.toHaveBeenCalledWith('AsanaApiFailed', 'Count', 1);
  });

  it('emits AsanaApiFailed and rethrows when the Asana client throws', async () => {
    const failing = fakeAsanaClient({
      createTask: async () => {
        throw new Error('Asana API request failed with status 500');
      },
    });
    const { service, metricsClient, repo } = makeService(fixtureRecord(), { asanaClient: failing });

    await expect(
      service.createAsanaFollowup({ commId: COMM_ID, userId: OWNER_USER_ID, title: 'Follow up' }),
    ).rejects.toThrow('status 500');
    expect(metricsClient.addMetric).toHaveBeenCalledWith('AsanaApiFailed', 'Count', 1);
    expect(repo.record.asanaTaskGid).toBeUndefined();
  });
});

describe('AsanaService — linkAsana', () => {
  it('links to an existing task and persists gid+permalink on the communication record', async () => {
    const { service, repo, asanaClient } = makeService(fixtureRecord());
    const result = await service.linkAsana({
      commId: COMM_ID,
      userId: OWNER_USER_ID,
      taskGid: 'task-99',
    });

    expect(result.asanaTaskGid).toBe('task-99');
    expect(repo.record.asanaTaskGid).toBe('task-99');
    expect(asanaClient.linkCalls[0]!.taskGid).toBe('task-99');
    expect(asanaClient.linkCalls[0]!.provenance.commId).toBe(COMM_ID);
  });

  it('re-linking the same commId to the same taskGid converges to the same record state (idempotent)', async () => {
    const { service, repo } = makeService(fixtureRecord());
    await service.linkAsana({ commId: COMM_ID, userId: OWNER_USER_ID, taskGid: 'task-99' });
    const first = { ...repo.record };
    await service.linkAsana({ commId: COMM_ID, userId: OWNER_USER_ID, taskGid: 'task-99' });

    expect(repo.record.asanaTaskGid).toBe(first.asanaTaskGid);
    expect(repo.record.asanaTaskPermalink).toBe(first.asanaTaskPermalink);
  });

  it('emits AsanaApiFailed and rethrows when the Asana client throws', async () => {
    const failing = fakeAsanaClient({
      linkToCommunication: async () => {
        throw new Error('Asana API request failed with status 404');
      },
    });
    const { service, metricsClient } = makeService(fixtureRecord(), { asanaClient: failing });

    await expect(
      service.linkAsana({ commId: COMM_ID, userId: OWNER_USER_ID, taskGid: 'task-99' }),
    ).rejects.toThrow('status 404');
    expect(metricsClient.addMetric).toHaveBeenCalledWith('AsanaApiFailed', 'Count', 1);
  });
});

describe('AsanaService — listAsanaProjects', () => {
  it('returns the projects the client lists (read-only, no communication scoping)', async () => {
    const { service } = makeService(fixtureRecord());
    const projects = await service.listAsanaProjects({ userId: OWNER_USER_ID });
    expect(projects).toEqual([{ gid: PROJECT_GID, name: 'CoS Communication Agent' }]);
  });
});

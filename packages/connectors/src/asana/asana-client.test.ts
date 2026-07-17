import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AsanaClient,
  AsanaApiError,
  ScopeViolationError,
  loadAsanaSecret,
  resetAsanaSecretCacheForTests,
  formatProvenanceNote,
  ASANA_API_BASE_URL,
} from './asana-client.js';

const smMock = mockClient(SecretsManagerClient);

const FAKE_SECRET = {
  pat: 'fake-pat-never-logged',
  workspace_gid: 'ws-1',
  project_gid: 'proj-1',
};

function jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ data }), { status, headers });
}

/** Raw envelope (not auto-wrapped in `{data}`) — for asserting on Asana's `next_page` pagination
 * shape directly. */
function rawResponse(status: number, envelope: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(envelope), { status, headers });
}

describe('loadAsanaSecret — secret caching (mirrors gmail-client.ts)', () => {
  beforeEach(() => {
    smMock.reset();
    resetAsanaSecretCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hits Secrets Manager once for two calls within the TTL', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/asana' }).resolves({
      SecretString: JSON.stringify(FAKE_SECRET),
    });

    const first = await loadAsanaSecret();
    const second = await loadAsanaSecret();

    expect(first).toEqual(FAKE_SECRET);
    expect(second).toEqual(FAKE_SECRET);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('re-fetches after the cache TTL expires', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/asana' }).resolves({
      SecretString: JSON.stringify(FAKE_SECRET),
    });

    await loadAsanaSecret();
    vi.setSystemTime(new Date('2026-07-16T00:05:01.000Z'));
    await loadAsanaSecret();

    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  it('rejects a malformed secret (missing project_gid)', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'cos/asana' }).resolves({
      SecretString: JSON.stringify({ pat: 'x', workspace_gid: 'ws-1' }),
    });

    await expect(loadAsanaSecret()).rejects.toThrow();
  });
});

describe('AsanaClient — scoping (project_gid confinement)', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  let client: AsanaClient;

  beforeEach(() => {
    fetchImpl = vi.fn();
    client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep: async () => {},
    });
  });

  it('createTask always includes projects:[project_gid] and never a caller-supplied project', async () => {
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(201, { gid: 'task-1', name: 'Follow up', notes: '' }),
    );

    await client.createTask({ name: 'Follow up', notes: 'context' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ASANA_API_BASE_URL}/tasks`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.data.projects).toEqual(['proj-1']);
    expect(body.data.name).toBe('Follow up');
  });

  it('listCommunicationAgentTasks queries ONLY /projects/{project_gid}/tasks, never a workspace-wide endpoint', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, []));

    await client.listCommunicationAgentTasks();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url as string).toContain('/projects/proj-1/tasks');
    expect(url as string).not.toContain('/workspaces/');
  });

  it('listCommunicationAgentTasks follows Asana offset pagination across pages (never assumes one page)', async () => {
    // Page 1: a task + a next_page.offset cursor. Page 2: another task, no next_page (last page).
    fetchImpl
      .mockResolvedValueOnce(
        rawResponse(200, {
          data: [{ gid: 'task-a', name: 'A' }],
          next_page: { offset: 'cursor-2' },
        }),
      )
      .mockResolvedValueOnce(
        rawResponse(200, { data: [{ gid: 'task-b', name: 'B' }], next_page: null }),
      );

    const tasks = await client.listCommunicationAgentTasks();

    expect(tasks.map((t) => t.gid)).toEqual(['task-a', 'task-b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Page 1 has no offset param; page 2 carries the cursor returned by page 1.
    expect(fetchImpl.mock.calls[0]![0] as string).not.toContain('offset=');
    expect(fetchImpl.mock.calls[1]![0] as string).toContain('offset=cursor-2');
    // Both pages stay scoped to the dedicated project — pagination never widens the endpoint.
    expect(fetchImpl.mock.calls[0]![0] as string).toContain('/projects/proj-1/tasks');
    expect(fetchImpl.mock.calls[1]![0] as string).toContain('/projects/proj-1/tasks');
  });

  it('has no method that reads the workspace-wide projects or tasks endpoints', () => {
    // Privacy scoping (Task 7 brief, Critical finding 1): `listProjects` (GET
    // /workspaces/{gid}/projects) must not exist on the client at all — the dashboard/UI never
    // needs to browse the user's other Asana projects, only the one configured `project_gid`.
    expect((client as unknown as { listProjects?: unknown }).listProjects).toBeUndefined();
  });

  it('the client source has no reference to a workspace-wide projects or tasks endpoint path', async () => {
    // Belt-and-suspenders static check alongside the runtime assertions above: grep this module's
    // own source for the workspace-scoped endpoints and assert none remain outside doc comments
    // that explicitly say the endpoint is NOT called.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, 'asana-client.ts'), 'utf8');

    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    expect(codeOnly).not.toContain('/workspaces/');
  });

  it('never logs or exposes the PAT in a thrown error message', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(401, { errors: [{ message: 'Not Authorized' }] }));

    await expect(client.getTask('task-1')).rejects.toThrow(AsanaApiError);
    try {
      await client.getTask('task-1');
    } catch (error) {
      expect(String(error)).not.toContain(FAKE_SECRET.pat);
    }
  });
});

describe('AsanaClient — retry/backoff/timeout', () => {
  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { errors: [] }, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { gid: 'task-1', name: 'ok' }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep,
    });

    const result = await client.getTask('task-1');

    expect(result.gid).toBe('task-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx with exponential backoff, then gives up after maxRetries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { errors: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep,
      maxRetries: 2,
      baseBackoffMs: 100,
    });

    await expect(client.getTask('task-1')).rejects.toThrow(AsanaApiError);
    // 1 initial + 2 retries = 3 calls
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('does not retry a non-retryable 4xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { errors: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep,
    });

    await expect(client.getTask('task-1')).rejects.toThrow(AsanaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('aborts and throws a clear error on timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      timeoutMs: 5,
      sleep: async () => {},
    });

    await expect(client.getTask('task-1')).rejects.toThrow(/timed out/);
  });
});

describe('AsanaClient — task lifecycle + linking', () => {
  it('updateTask sends only the provided fields', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { gid: 'task-1', name: 'Updated' }));
    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep: async () => {},
    });

    await client.updateTask('task-1', { name: 'Updated' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ASANA_API_BASE_URL}/tasks/task-1`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.data).toEqual({ name: 'Updated' });
  });

  it('addComment posts to the task stories endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { gid: 'story-1', text: 'hello' }));
    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep: async () => {},
    });

    const story = await client.addComment('task-1', 'hello');

    expect(story.gid).toBe('story-1');
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ASANA_API_BASE_URL}/tasks/task-1/stories`);
  });

  it('linkToCommunication checks project membership, posts a provenance comment, then returns the refreshed task', async () => {
    const fetchImpl = vi
      .fn()
      // 1) membership check: getTask returns the task WITH proj-1 in `projects`
      .mockResolvedValueOnce(
        jsonResponse(200, {
          gid: 'task-1',
          name: 'Follow up',
          projects: [{ gid: 'proj-1', name: 'CoS Communication Agent' }],
        }),
      )
      // 2) the provenance comment
      .mockResolvedValueOnce(jsonResponse(201, { gid: 'story-1', text: 'note' }))
      // 3) the refreshed task returned to the caller
      .mockResolvedValueOnce(
        jsonResponse(200, {
          gid: 'task-1',
          name: 'Follow up',
          permalink_url: 'https://app.asana.com/0/proj-1/task-1',
          projects: [{ gid: 'proj-1', name: 'CoS Communication Agent' }],
        }),
      );
    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep: async () => {},
    });

    const task = await client.linkToCommunication('task-1', {
      commId: 'gmail#abc',
      channel: 'gmail',
      threadKey: 'thread-1',
      ts: '2026-07-16T00:00:00.000Z',
      senderName: 'Alex',
      subject: 'Q3 budget',
    });

    expect(task.permalink_url).toContain('task-1');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [membershipUrl, membershipInit] = fetchImpl.mock.calls[0]!;
    expect(membershipUrl as string).toContain('/tasks/task-1');
    expect((membershipInit as RequestInit).method).toBe('GET');
    const [, commentInit] = fetchImpl.mock.calls[1]!;
    const commentBody = JSON.parse((commentInit as RequestInit).body as string);
    expect(commentBody.data.text).toContain('gmail#abc');
    expect(commentBody.data.text).toContain('Alex');
  });

  it('linkToCommunication rejects a task outside project_gid with ScopeViolationError, never posting a comment', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        gid: 'other-task-1',
        name: 'Someone else’s task',
        projects: [{ gid: 'other-proj-9', name: 'A different project' }],
      }),
    );
    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep: async () => {},
    });

    await expect(
      client.linkToCommunication('other-task-1', {
        commId: 'gmail#abc',
        channel: 'gmail',
        threadKey: 'thread-1',
        ts: '2026-07-16T00:00:00.000Z',
      }),
    ).rejects.toThrow(ScopeViolationError);

    // Only the membership-check GET happened — no comment POST, no second getTask.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('GET');
  });

  it('linkToCommunication rejects a task with no projects at all (fail closed)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { gid: 'orphan-task-1', name: 'No project task' }));
    const client = new AsanaClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSecret: async () => FAKE_SECRET,
      sleep: async () => {},
    });

    await expect(
      client.linkToCommunication('orphan-task-1', {
        commId: 'gmail#abc',
        channel: 'gmail',
        threadKey: 'thread-1',
        ts: '2026-07-16T00:00:00.000Z',
      }),
    ).rejects.toThrow(ScopeViolationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('formatProvenanceNote never includes a full message body field', () => {
    const note = formatProvenanceNote({
      commId: 'gmail#abc',
      channel: 'gmail',
      threadKey: 'thread-1',
      ts: '2026-07-16T00:00:00.000Z',
      senderName: 'Alex',
      subject: 'Q3 budget',
    });
    expect(note).toContain('gmail#abc');
    expect(note).toContain('Alex');
    expect(note).toContain('Q3 budget');
  });
});

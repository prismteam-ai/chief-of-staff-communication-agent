import { describe, expect, it } from 'vitest';
import { runManageAsana } from './manage-asana.js';
import type { McpApiClient } from '../lib/api-client.js';

/** Coverage for `manageAsana`'s confirm gate — same guarantee as `approve-draft.test.ts`: no Asana
 * write reaches the hosted API unless `confirm: true` is explicit. */

function fakeClient(): McpApiClient & { mutateCalls: unknown[] } {
  const mutateCalls: unknown[] = [];
  return {
    mutateCalls,
    async query() {
      throw new Error('not used in this test');
    },
    async mutate(procedure, input) {
      mutateCalls.push({ procedure, input });
      return {
        commId: 'comm-1',
        asanaTaskGid: 'task-1',
        asanaTaskPermalink: 'https://asana/task-1',
      } as never;
    },
  };
}

describe('runManageAsana — confirm gate', () => {
  it('does NOT write to Asana when confirm is omitted (action: create)', async () => {
    const client = fakeClient();

    const result = await runManageAsana(client, {
      action: 'create',
      commId: 'comm-1',
      title: 'Follow up',
    });

    expect(result.status).toBe('preview');
    expect(client.mutateCalls).toHaveLength(0);
  });

  it('does NOT write to Asana when confirm is omitted (action: link)', async () => {
    const client = fakeClient();

    const result = await runManageAsana(client, {
      action: 'link',
      commId: 'comm-1',
      taskGid: 'task-1',
    });

    expect(result.status).toBe('preview');
    expect(client.mutateCalls).toHaveLength(0);
  });

  it('creates a real task only when confirm is true', async () => {
    const client = fakeClient();

    const result = await runManageAsana(client, {
      action: 'create',
      commId: 'comm-1',
      title: 'Follow up',
      confirm: true,
    });

    expect(result.status).toBe('done');
    expect(client.mutateCalls).toEqual([
      {
        procedure: 'manageAsanaCreate',
        input: { commId: 'comm-1', title: 'Follow up', notes: undefined, dueOn: undefined },
      },
    ]);
  });

  it('links a real task only when confirm is true', async () => {
    const client = fakeClient();

    const result = await runManageAsana(client, {
      action: 'link',
      commId: 'comm-1',
      taskGid: 'task-1',
      confirm: true,
    });

    expect(result.status).toBe('done');
    expect(client.mutateCalls).toEqual([
      { procedure: 'manageAsanaLink', input: { commId: 'comm-1', taskGid: 'task-1' } },
    ]);
  });

  it('rejects action "create" with confirm: true but no title before calling the API', async () => {
    const client = fakeClient();

    await expect(
      runManageAsana(client, { action: 'create', commId: 'comm-1', confirm: true }),
    ).rejects.toThrow(/requires a title/);
    expect(client.mutateCalls).toHaveLength(0);
  });

  it('rejects action "link" with confirm: true but no taskGid before calling the API', async () => {
    const client = fakeClient();

    await expect(
      runManageAsana(client, { action: 'link', commId: 'comm-1', confirm: true }),
    ).rejects.toThrow(/requires a taskGid/);
    expect(client.mutateCalls).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { runApproveDraft } from './approve-draft.js';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * Coverage for the confirm-gate itself (Task 11 brief constraint 2 + 7): `approveDraft` must NEVER
 * call the hosted mutation unless `confirm: true` is explicitly passed — this is the structural
 * guarantee that a real send cannot happen without the human's explicit approval reaching this
 * handler as a boolean, not inferred from anything else.
 */

function fakeClient(
  overrides: Partial<McpApiClient> = {},
): McpApiClient & { mutateCalls: unknown[] } {
  const mutateCalls: unknown[] = [];
  return {
    mutateCalls,
    async query() {
      throw new Error('not used in this test');
    },
    async mutate(procedure, input) {
      mutateCalls.push({ procedure, input });
      return { commId: 'comm-1', sentMessageId: 'gmail-sent-1' } as never;
    },
    ...overrides,
  };
}

describe('runApproveDraft — confirm gate', () => {
  it('does NOT call the API when confirm is omitted', async () => {
    const client = fakeClient();

    const result = await runApproveDraft(client, { commId: 'comm-1' });

    expect(result.status).toBe('preview');
    expect(client.mutateCalls).toHaveLength(0);
  });

  it('does NOT call the API when confirm is explicitly false', async () => {
    const client = fakeClient();

    const result = await runApproveDraft(client, { commId: 'comm-1', confirm: false });

    expect(result.status).toBe('preview');
    expect(client.mutateCalls).toHaveLength(0);
  });

  it('calls the real approveDraft mutation only when confirm is true', async () => {
    const client = fakeClient();

    const result = await runApproveDraft(client, { commId: 'comm-1', confirm: true });

    expect(result.status).toBe('sent');
    expect(client.mutateCalls).toEqual([
      { procedure: 'approveDraft', input: { commId: 'comm-1' } },
    ]);
  });
});

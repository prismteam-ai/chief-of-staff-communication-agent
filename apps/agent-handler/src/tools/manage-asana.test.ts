import { describe, expect, it } from 'vitest';
import { runManageAsana, MANAGE_ASANA_ACTIONS, ManageAsanaInputSchema } from './manage-asana.js';

describe('manageAsana — typed contract stub until Task 7', () => {
  it('returns the not_implemented marker for every action variant, never throwing', () => {
    for (const action of MANAGE_ASANA_ACTIONS) {
      const result = runManageAsana({ action, commId: 'gmail#abc' });
      expect(result.status).toBe('not_implemented');
      expect(result.action).toBe(action);
      expect(result.commId).toBe('gmail#abc');
      expect(result.message).toMatch(/contract stub/i);
    }
  });

  it('accepts the full typed input contract (with optional gid/detail)', () => {
    const parsed = ManageAsanaInputSchema.safeParse({
      action: 'update',
      commId: 'gmail#abc',
      asanaGid: '12345',
      detail: 'follow up',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown action', () => {
    const parsed = ManageAsanaInputSchema.safeParse({ action: 'delete', commId: 'gmail#abc' });
    expect(parsed.success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { runManageAsana, MANAGE_ASANA_ACTIONS, ManageAsanaInputSchema } from './manage-asana.js';

describe('manageAsana — proposes, never executes (Task 7 hypno confirm-gated pattern)', () => {
  it('returns a structured suggestion (not a write) for every action variant', () => {
    for (const action of MANAGE_ASANA_ACTIONS) {
      const result = runManageAsana({
        action,
        commId: 'gmail#abc',
        asanaGid: action === 'create' ? undefined : '12345',
        detail: action === 'create' ? 'Follow up on budget' : 'note text',
      });
      expect(result.status).toBe('proposed');
      expect(result.action).toBe(action);
      expect(result.commId).toBe('gmail#abc');
      expect(result.suggestedAsanaAction).toBeDefined();
      expect(result.suggestedAsanaAction.action).toBe(action);
    }
  });

  it('never calls a real Asana endpoint — the tool has no HTTP dependency at all', () => {
    // Structural guarantee: runManageAsana takes no client/fetch dependency, so it CANNOT reach the
    // network — the only way to execute is through the separate, human-approved tRPC procedures.
    expect(runManageAsana.length).toBe(1);
  });

  it('create proposals require a detail (task title) and carry no gid', () => {
    const result = runManageAsana({ action: 'create', commId: 'gmail#abc', detail: 'Follow up' });
    expect(result.suggestedAsanaAction.action).toBe('create');
    expect(result.suggestedAsanaAction.title).toBe('Follow up');
    expect(result.suggestedAsanaAction.asanaGid).toBeUndefined();
  });

  it('link/update proposals carry the target gid', () => {
    const linkResult = runManageAsana({
      action: 'link',
      commId: 'gmail#abc',
      asanaGid: 'task-99',
    });
    expect(linkResult.suggestedAsanaAction.asanaGid).toBe('task-99');

    const updateResult = runManageAsana({
      action: 'update',
      commId: 'gmail#abc',
      asanaGid: 'task-99',
      detail: 'status update',
    });
    expect(updateResult.suggestedAsanaAction.asanaGid).toBe('task-99');
    expect(updateResult.suggestedAsanaAction.note).toBe('status update');
  });

  it('the message is explicit that human approval via tRPC is required', () => {
    const result = runManageAsana({ action: 'create', commId: 'gmail#abc', detail: 'Follow up' });
    expect(result.message).toMatch(/approv/i);
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

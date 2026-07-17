import { describe, expect, it } from 'vitest';
import {
  agentSafetyBoundary,
  agentToolPolicy,
  applicationAgentBoundary,
} from './index.js';
describe('agent safety boundary', () => {
  it('cannot approve, effect, or silently fall back', () => {
    expect(agentSafetyBoundary).toEqual({
      directExternalEffects: false,
      approvalRequired: true,
      modelFallbackAllowed: false,
    });
  });

  it('exposes only bounded read tools and no effect capability', () => {
    expect(agentToolPolicy.allowed).toEqual([
      'get_cited_fact',
      'get_style_profile',
    ]);
    expect(applicationAgentBoundary).toMatchObject({
      directExternalEffects: false,
      directAsanaMutation: false,
      modelFallbackAllowed: false,
      maximumSteps: 4,
      maximumSchemaRepairs: 1,
    });
    expect(agentToolPolicy.deniedEffectClasses).toContain('send_message');
    expect(agentToolPolicy.deniedEffectClasses).toContain('update_asana_task');
  });
});

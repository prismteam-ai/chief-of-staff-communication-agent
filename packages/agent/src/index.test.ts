import { describe, expect, it } from 'vitest';
import { agentSafetyBoundary } from './index.js';
describe('agent safety boundary', () => {
  it('cannot approve, effect, or silently fall back', () => {
    expect(agentSafetyBoundary).toEqual({
      directExternalEffects: false,
      approvalRequired: true,
      modelFallbackAllowed: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertExternalEffectsEnabled,
  externalEffectControl,
  ExternalEffectsDisabledError,
} from './index.js';
describe('effect control', () => {
  it('defaults off and fails closed', () => {
    expect(externalEffectControl.defaultState).toBe('disabled');
    expect(() => assertExternalEffectsEnabled(false)).toThrow(
      ExternalEffectsDisabledError,
    );
  });
});

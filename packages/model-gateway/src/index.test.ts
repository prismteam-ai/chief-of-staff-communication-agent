import { describe, expect, it } from 'vitest';

import { modelGatewayPolicy } from './index.js';

describe('model gateway policy', () => {
  it('freezes the no-direct-call and no-fallback boundary', () => {
    expect(modelGatewayPolicy).toEqual({
      provider: 'amazon-bedrock',
      gateway: 'vercel-ai-sdk',
      directProviderCallsAllowed: false,
      silentFallbackAllowed: false,
    });
    expect(Object.isFrozen(modelGatewayPolicy)).toBe(true);
  });
});

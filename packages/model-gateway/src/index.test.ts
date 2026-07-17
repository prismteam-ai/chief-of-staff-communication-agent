import { describe, expect, it } from 'vitest';

import { MockLanguageModelV3 } from 'ai/test';

import {
  applyBedrockPromptCaching,
  createInjectedModelGateway,
  createModelProfile,
  modelGatewayPolicy,
} from './index.js';

const profile = {
  profileId: 'chief-generation-v1',
  modelId: 'us.amazon.nova-pro-v1:0',
  region: 'us-east-2',
  gatewayVersion: 'ai@6.0.230',
  promptPolicyHash: 'a'.repeat(64),
  actionContextRoute: 'chief-action-v1',
  draftRoute: 'chief-draft-v1',
} as const;

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

  it('requires and hashes one explicit production profile deterministically', () => {
    const first = createModelProfile(profile);
    const second = createModelProfile({ ...profile });

    expect(first).toEqual(second);
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.gateway).toBe('vercel-ai-sdk');
  });

  it('keeps injected deterministic models behind the same no-fallback seam', () => {
    const languageModel = new MockLanguageModelV3();
    const gateway = createInjectedModelGateway({ profile, languageModel });

    expect(gateway.languageModel).toBe(languageModel);
    expect(gateway.fallbackProfile).toBeNull();
  });

  it('adds cache points without discarding existing provider options', () => {
    const result = applyBedrockPromptCaching([
      {
        role: 'system',
        content: 'immutable policy',
        providerOptions: { bedrock: { reasoningConfig: { type: 'enabled' } } },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'untrusted message' }],
        providerOptions: { custom: { trace: 'kept' } },
      },
    ]);

    expect(result.cachePointsAdded).toBe(2);
    expect(result.prompt[0]?.providerOptions).toEqual({
      bedrock: {
        reasoningConfig: { type: 'enabled' },
        cachePoint: { type: 'default' },
      },
    });
    expect(result.prompt[1]?.providerOptions).toEqual({
      custom: { trace: 'kept' },
      bedrock: { cachePoint: { type: 'default' } },
    });
  });
});

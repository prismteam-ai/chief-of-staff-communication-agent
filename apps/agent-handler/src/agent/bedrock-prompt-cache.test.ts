import { describe, expect, it } from 'vitest';
import {
  applyBedrockPromptCaching,
  readCacheTokens,
  BEDROCK_PROMPT_CACHE_METADATA,
} from './bedrock-prompt-cache.js';

// The middleware's prompt type is derived structurally from the AI SDK; for these placement tests a
// minimal role-tagged message shape is sufficient. We build it loosely and pass it through the pure
// function under test.
type TestMessage = {
  role: string;
  content?: unknown;
  providerOptions?: Record<string, unknown>;
};

function run(messages: TestMessage[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only structural cast; the
  // production type is derived from the SDK and not constructible in a unit test without the SDK's
  // internal message builders.
  return applyBedrockPromptCaching(messages as any);
}

function bedrockOptions(msg: TestMessage): Record<string, unknown> {
  return (msg.providerOptions?.bedrock ?? {}) as Record<string, unknown>;
}

describe('applyBedrockPromptCaching — cache-point placement', () => {
  it('marks the first system message and the last non-system message', () => {
    const messages: TestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const { prompt, cachePointsAdded } = run(messages);
    expect(cachePointsAdded).toBe(2);

    const out = prompt as unknown as TestMessage[];
    // first system (index 0) is marked
    expect(bedrockOptions(out[0]!).cachePoint).toEqual({ type: 'default' });
    // last non-system (index 3) is marked
    expect(bedrockOptions(out[3]!).cachePoint).toEqual({ type: 'default' });
    // the middle messages are NOT marked
    expect(bedrockOptions(out[1]!).cachePoint).toBeUndefined();
    expect(bedrockOptions(out[2]!).cachePoint).toBeUndefined();
  });

  it('preserves existing (non-cachePoint) provider options and only sets bedrock.cachePoint', () => {
    const messages: TestMessage[] = [
      {
        role: 'system',
        content: 'sys',
        providerOptions: {
          bedrock: { reasoningConfig: { type: 'enabled' } },
          langsmith: { metadata: { keep: true } },
        },
      },
      { role: 'user', content: 'u1' },
    ];
    const { prompt } = run(messages);
    const out = prompt as unknown as TestMessage[];

    const sysBedrock = bedrockOptions(out[0]!);
    expect(sysBedrock.reasoningConfig).toEqual({ type: 'enabled' }); // preserved
    expect(sysBedrock.cachePoint).toEqual({ type: 'default' }); // added
    // non-bedrock provider option survives untouched
    expect(out[0]!.providerOptions?.langsmith).toEqual({ metadata: { keep: true } });
  });

  it('marks the same message once when the only non-system message is also the last', () => {
    const messages: TestMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'only-user' },
    ];
    const { cachePointsAdded } = run(messages);
    expect(cachePointsAdded).toBe(2); // one system + one non-system, distinct indexes
  });

  it('adds no cache points to an empty prompt', () => {
    const { cachePointsAdded } = run([]);
    expect(cachePointsAdded).toBe(0);
  });
});

describe('readCacheTokens', () => {
  it('reads public inputTokenDetails cache token names', () => {
    expect(
      readCacheTokens({ inputTokenDetails: { cacheReadTokens: 12, cacheWriteTokens: 3 } }),
    ).toEqual({ cacheRead: 12, cacheWrite: 3 });
  });

  it('falls back to raw provider usage names', () => {
    expect(readCacheTokens({ cacheReadInputTokens: 5, cacheWriteInputTokens: 7 })).toEqual({
      cacheRead: 5,
      cacheWrite: 7,
    });
  });

  it('returns zeros for absent / malformed usage', () => {
    expect(readCacheTokens(undefined)).toEqual({ cacheRead: 0, cacheWrite: 0 });
    expect(readCacheTokens(null)).toEqual({ cacheRead: 0, cacheWrite: 0 });
    expect(readCacheTokens({})).toEqual({ cacheRead: 0, cacheWrite: 0 });
  });
});

describe('BEDROCK_PROMPT_CACHE_METADATA', () => {
  it('declares the exact strategy keys LangSmith queries compare on', () => {
    expect(BEDROCK_PROMPT_CACHE_METADATA).toMatchObject({
      bedrock_prompt_caching: true,
      bedrock_prompt_cache_strategy: 'system_and_last_non_system',
      bedrock_prompt_cache_ttl: 'default',
      bedrock_prompt_cache_tool_config: false,
    });
  });
});

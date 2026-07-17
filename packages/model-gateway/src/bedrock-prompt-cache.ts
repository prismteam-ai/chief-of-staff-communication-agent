import { wrapLanguageModel } from 'ai';

import type { GatewayLanguageModel } from './gateway.js';

type ModelCallOptions = Parameters<GatewayLanguageModel['doGenerate']>[0];
type Prompt = ModelCallOptions['prompt'];
type PromptMessage = Prompt[number];
type ModelUsage = Awaited<
  ReturnType<GatewayLanguageModel['doGenerate']>
>['usage'];

const CACHE_POINT = Object.freeze({ type: 'default' as const });

export const BEDROCK_PROMPT_CACHE_METADATA = Object.freeze({
  bedrock_prompt_caching: true,
  bedrock_prompt_cache_strategy: 'system_and_last_non_system',
  bedrock_prompt_cache_ttl: 'default',
  bedrock_prompt_cache_tool_config: false,
} as const);

export interface PromptCacheUsage {
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

export interface PromptCacheObserver {
  record(usage: PromptCacheUsage): void;
}

function addCachePoint(message: PromptMessage): PromptMessage {
  const providerOptions = message.providerOptions ?? {};
  const bedrock =
    typeof providerOptions.bedrock === 'object' &&
    providerOptions.bedrock !== null
      ? providerOptions.bedrock
      : {};
  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      bedrock: { ...bedrock, cachePoint: CACHE_POINT },
    },
  };
}

export function applyBedrockPromptCaching(prompt: Prompt): {
  readonly prompt: Prompt;
  readonly cachePointsAdded: number;
} {
  const targets = new Set<number>();
  const firstSystem = prompt.findIndex(({ role }) => role === 'system');
  if (firstSystem >= 0) targets.add(firstSystem);
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role !== 'system') {
      targets.add(index);
      break;
    }
  }
  return Object.freeze({
    prompt: prompt.map((message, index) =>
      targets.has(index) ? addCachePoint(message) : message,
    ),
    cachePointsAdded: targets.size,
  });
}

function observeUsage(
  observer: PromptCacheObserver | undefined,
  usage: ModelUsage | undefined,
): void {
  if (!observer || !usage) return;
  const cacheReadInputTokens = usage.inputTokens.cacheRead ?? 0;
  const cacheWriteInputTokens = usage.inputTokens.cacheWrite ?? 0;
  if (cacheReadInputTokens === 0 && cacheWriteInputTokens === 0) return;
  observer.record(
    Object.freeze({ cacheReadInputTokens, cacheWriteInputTokens }),
  );
}

export function withBedrockPromptCaching(
  model: GatewayLanguageModel,
  observer?: PromptCacheObserver,
): GatewayLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      transformParams: ({ params }) =>
        Promise.resolve({
          ...params,
          prompt: applyBedrockPromptCaching(params.prompt).prompt,
        }),
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        observeUsage(observer, result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === 'finish') observeUsage(observer, chunk.usage);
              controller.enqueue(chunk);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
}

import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { logger } from '../context.js';

/**
 * Bedrock prompt caching (kit skill `implementation-bedrock-prompt-caching.md`, Task 5 constraint 1
 * "keep the cache-point-on-first-system-and-last-non-system-message logic"). Cache points are
 * applied through AI SDK language-model middleware so the policy is centralized and every agent
 * invocation uses it.
 *
 * ## Adaptations from the kit skill (documented, per the "adapt the API letter" instruction)
 *  - The kit's helper types itself against `specificationVersion: 'v3'`. In this repo's pinned
 *    stack (`ai@7`, `@ai-sdk/amazon-bedrock@5`) the Bedrock model reports `specificationVersion:
 *    'v4'` and the AI SDK's public `LanguageModelMiddleware` type deliberately relaxes
 *    `specificationVersion` to an optional string — so the middleware is typed as
 *    `LanguageModelMiddleware` and the prompt-message type is derived structurally from the SDK's
 *    own middleware parameter rather than hand-pinned to a spec generation. This keeps the helper
 *    correct across the v3→v4 provider-spec bump without re-pinning.
 *  - The logger is this repo's Powertools logger from `context.ts` (kit skill note: "adjust only
 *    the logger import path"), not the kit's `logRuntime`.
 */

/**
 * The concrete language-model object type (not the `string | Model` union `LanguageModel` widens
 * to). `wrapLanguageModel` requires the object form; the kit skill narrows via
 * `Extract<LanguageModel, { specificationVersion: 'v3' }>` — here the installed Bedrock model is
 * spec `'v4'` (see adaptation note above), so we narrow to `'v4'`.
 */
type BedrockLanguageModel = Extract<LanguageModel, { specificationVersion: 'v4' }>;

const BEDROCK_CACHE_POINT = { type: 'default' as const };

/**
 * Cache-policy metadata attached to every traced AI run so LangSmith queries can compare cached vs
 * uncached runs (kit skill "LangSmith Metadata" table). Merged into the LangSmith provider options
 * in `langsmith.ts`.
 */
export const BEDROCK_PROMPT_CACHE_METADATA = {
  bedrock_prompt_caching: true,
  bedrock_prompt_cache_strategy: 'system_and_last_non_system',
  bedrock_prompt_cache_ttl: 'default',
  bedrock_prompt_cache_tool_config: false,
} as const;

/**
 * The prompt shape the middleware's `transformParams` receives — derived from the SDK's own
 * middleware type so it tracks the installed provider spec (see adaptation note above) instead of
 * being hand-pinned. A prompt is an array of role-tagged messages, each optionally carrying
 * `providerOptions`.
 */
type TransformParams = NonNullable<LanguageModelMiddleware['transformParams']>;
type MiddlewareParams = Parameters<TransformParams>[0]['params'];
type BedrockPrompt = MiddlewareParams['prompt'];
type BedrockPromptMessage = BedrockPrompt[number];

function withCachePoint(message: BedrockPromptMessage): BedrockPromptMessage {
  const providerOptions = message.providerOptions ?? {};
  const bedrockOptions =
    typeof providerOptions.bedrock === 'object' && providerOptions.bedrock !== null
      ? providerOptions.bedrock
      : {};

  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      // Overwrite ONLY `bedrock.cachePoint`; every other Bedrock option (reasoning config, etc.)
      // and every non-bedrock provider option is preserved (kit skill "Overwrite only an existing
      // bedrock.cachePoint; do not discard other Bedrock options").
      bedrock: {
        ...bedrockOptions,
        cachePoint: BEDROCK_CACHE_POINT,
      },
    },
  };
}

/**
 * Marks the first system message and the last non-system message with a Bedrock cache point.
 * Pure — returns a new prompt array and a count of cache points added (for tests). This is the
 * exact placement logic the kit skill prescribes.
 */
export function applyBedrockPromptCaching(prompt: BedrockPrompt): {
  prompt: BedrockPrompt;
  cachePointsAdded: number;
} {
  const targetIndexes = new Set<number>();

  const firstSystemIndex = prompt.findIndex((message) => message.role === 'system');
  if (firstSystemIndex >= 0) {
    targetIndexes.add(firstSystemIndex);
  }

  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role !== 'system') {
      targetIndexes.add(index);
      break;
    }
  }

  if (targetIndexes.size === 0) {
    return { prompt, cachePointsAdded: 0 };
  }

  return {
    prompt: prompt.map((message, index) =>
      targetIndexes.has(index) ? withCachePoint(message) : message,
    ),
    cachePointsAdded: targetIndexes.size,
  };
}

/**
 * Reads cache read/write token counts from a model-call usage object defensively. Provider-spec
 * usage shapes have shifted names across AI SDK generations; the public `inputTokenDetails`
 * (`cacheReadTokens`/`cacheWriteTokens`) is the stable surface, but a raw provider usage may still
 * carry `cacheReadInputTokens`/`cacheWriteInputTokens`. Both are probed; absent counts read as 0.
 */
export function readCacheTokens(usage: unknown): { cacheRead: number; cacheWrite: number } {
  if (typeof usage !== 'object' || usage === null) {
    return { cacheRead: 0, cacheWrite: 0 };
  }
  const record = usage as Record<string, unknown>;
  const details =
    typeof record.inputTokenDetails === 'object' && record.inputTokenDetails !== null
      ? (record.inputTokenDetails as Record<string, unknown>)
      : {};

  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

  const cacheRead = num(details.cacheReadTokens) || num(record.cacheReadInputTokens);
  const cacheWrite = num(details.cacheWriteTokens) || num(record.cacheWriteInputTokens);
  return { cacheRead, cacheWrite };
}

function logCacheUsage(usage: unknown): void {
  const { cacheRead, cacheWrite } = readCacheTokens(usage);
  if (cacheRead <= 0 && cacheWrite <= 0) {
    return;
  }
  logger.info('Bedrock prompt cache usage.', {
    bedrockPromptCacheReadInputTokens: cacheRead,
    bedrockPromptCacheWriteInputTokens: cacheWrite,
  });
}

/**
 * Wraps a Bedrock language model with the prompt-cache middleware. Call this immediately after
 * `bedrock(modelId)` and before constructing the `ToolLoopAgent` (kit skill: "Do NOT pass a raw
 * Bedrock model into ToolLoopAgent"). Logs cache read/write tokens from both generated and
 * streamed responses.
 */
export function withBedrockPromptCaching(model: BedrockLanguageModel): BedrockLanguageModel {
  const middleware: LanguageModelMiddleware = {
    // Relaxed to optional string in the SDK's public middleware type (see adaptation note); the
    // installed Bedrock model is spec 'v4'.
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({
      ...params,
      prompt: applyBedrockPromptCaching(params.prompt).prompt,
    }),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      logCacheUsage(result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === 'finish') {
              logCacheUsage(chunk.usage);
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return { ...result, stream };
    },
  };

  return wrapLanguageModel({ model, middleware });
}

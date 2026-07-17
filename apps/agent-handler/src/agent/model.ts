import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';
import { withBedrockPromptCaching } from './bedrock-prompt-cache.js';
import { loadRuntimeEnv } from '../env.js';

/**
 * Bedrock model bootstrap (kit skill `implementation-vercel-ai-tool-loop-agent.md` + Task 5
 * constraint 2: all LLM interaction goes through the Vercel AI SDK — there is NO direct
 * `@aws-sdk/client-bedrock-runtime` chat client anywhere in this package). The provider is created
 * with an explicit region and the standard credential provider chain (never hardcoded creds), and
 * the model is wrapped with prompt-cache middleware before it is ever handed to `ToolLoopAgent`.
 *
 * Built once at module scope so warm containers reuse it across invocations.
 */
const env = loadRuntimeEnv();

const bedrock = createAmazonBedrock({
  region: env.region,
  credentialProvider: fromNodeProviderChain(),
});

/**
 * The prompt-cache-wrapped chat model. `bedrock(modelId)` returns the concrete `v4` language-model
 * object; `withBedrockPromptCaching` narrows/wraps it. Cast through `LanguageModel` at the wrap
 * boundary because `bedrock(...)`'s return type is the SDK's model object and the cache helper is
 * typed against the narrowed `v4` variant.
 */
export const chatModel: LanguageModel = withBedrockPromptCaching(
  bedrock(env.bedrockModelId) as Parameters<typeof withBedrockPromptCaching>[0],
);

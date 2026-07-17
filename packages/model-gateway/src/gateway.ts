import { createHash } from 'node:crypto';

import {
  createAmazonBedrock,
  type AmazonBedrockProvider,
} from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { sha256Schema } from '@chief/contracts/ids';
import { z } from 'zod';

import {
  BEDROCK_PROMPT_CACHE_METADATA,
  type PromptCacheObserver,
  withBedrockPromptCaching,
} from './bedrock-prompt-cache.js';

export type GatewayLanguageModel = ReturnType<
  AmazonBedrockProvider['languageModel']
>;

export interface ModelProfileManifest {
  readonly schemaVersion: '1';
  readonly profileId: string;
  readonly modelId: string;
  readonly region: 'us-east-2';
  readonly gateway: 'vercel-ai-sdk';
  readonly gatewayVersion: string;
  readonly promptPolicyHash: string;
  readonly actionContextRoute: string;
  readonly draftRoute: string;
  readonly manifestHash: string;
}

export interface ModelGateway {
  readonly profile: ModelProfileManifest;
  readonly languageModel: GatewayLanguageModel;
  readonly fallbackProfile: null;
  readonly promptCacheMetadata: typeof BEDROCK_PROMPT_CACHE_METADATA;
}

const profileInputSchema = z
  .object({
    profileId: z.string().min(1),
    modelId: z.string().min(1),
    region: z.literal('us-east-2'),
    gatewayVersion: z.string().min(1),
    promptPolicyHash: sha256Schema,
    actionContextRoute: z.string().min(1),
    draftRoute: z.string().min(1),
  })
  .strict();

export type ModelProfileInput = z.input<typeof profileInputSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

export function hashModelProfile(input: ModelProfileInput): string {
  const parsed = profileInputSchema.parse(input);
  return createHash('sha256')
    .update(
      canonical({
        schemaVersion: '1',
        ...parsed,
        gateway: 'vercel-ai-sdk',
      }),
    )
    .digest('hex');
}

export function createModelProfile(
  input: ModelProfileInput,
): ModelProfileManifest {
  const parsed = profileInputSchema.parse(input);
  return Object.freeze({
    schemaVersion: '1',
    ...parsed,
    gateway: 'vercel-ai-sdk',
    manifestHash: hashModelProfile(parsed),
  });
}

export interface BedrockGatewayOptions {
  readonly profile: ModelProfileInput;
  readonly promptCacheObserver?: PromptCacheObserver;
  readonly credentialProvider?: ReturnType<typeof fromNodeProviderChain>;
}

/**
 * Builds the only production model route. Construction requires an explicit,
 * promoted profile; unavailable Bedrock calls propagate and are never replaced
 * by a second model or a canned result.
 */
export function createBedrockModelGateway(
  options: BedrockGatewayOptions,
): ModelGateway {
  const profile = createModelProfile(options.profile);
  const bedrock = createAmazonBedrock({
    region: profile.region,
    credentialProvider: options.credentialProvider ?? fromNodeProviderChain(),
  });
  const rawModel = bedrock.languageModel(profile.modelId);
  return Object.freeze({
    profile,
    languageModel: withBedrockPromptCaching(
      rawModel,
      options.promptCacheObserver,
    ),
    fallbackProfile: null,
    promptCacheMetadata: BEDROCK_PROMPT_CACHE_METADATA,
  });
}

/** Networkless/test seam that still executes the real ToolLoopAgent path. */
export function createInjectedModelGateway(input: {
  readonly profile: ModelProfileInput;
  readonly languageModel: GatewayLanguageModel;
}): ModelGateway {
  return Object.freeze({
    profile: createModelProfile(input.profile),
    languageModel: input.languageModel,
    fallbackProfile: null,
    promptCacheMetadata: BEDROCK_PROMPT_CACHE_METADATA,
  });
}

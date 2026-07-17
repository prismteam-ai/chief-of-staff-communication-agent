export * from './bedrock-prompt-cache.js';
export * from './gateway.js';

export const modelGatewayPolicy = Object.freeze({
  provider: 'amazon-bedrock',
  gateway: 'vercel-ai-sdk',
  directProviderCallsAllowed: false,
  silentFallbackAllowed: false,
} as const);

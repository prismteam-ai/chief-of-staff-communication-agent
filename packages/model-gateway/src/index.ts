export interface ModelProfileManifest {
  readonly schemaVersion: '1';
  readonly profileId: string;
  readonly region: 'us-east-2';
  readonly gateway: 'vercel-ai-sdk';
  readonly manifestHash: string;
}

export interface ModelGateway {
  readonly profile: ModelProfileManifest;
}

export const modelGatewayPolicy = Object.freeze({
  provider: 'amazon-bedrock',
  gateway: 'vercel-ai-sdk',
  directProviderCallsAllowed: false,
  silentFallbackAllowed: false,
} as const);

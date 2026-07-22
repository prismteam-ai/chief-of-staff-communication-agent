import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import type {
  ConnectorCapabilities,
  ConnectorDescriptor,
} from '@chief/contracts/connectors';

export const X_LEGACY_DM_CONNECTOR_ID = 'x_legacy_dm';
export const XCHAT_ENCRYPTED_CONNECTOR_ID = 'xchat_encrypted';
export const X_OAUTH_AUDIENCE = 'https://api.x.com/';
export const X_LEGACY_DM_SCOPES = Object.freeze([
  'tweet.read',
  'users.read',
  'dm.read',
  'dm.write',
  'offline.access',
]);

const disabledCapabilities: ConnectorCapabilities = {
  read: false,
  send: false,
  webhook: false,
  poll: false,
  threads: false,
  attachments: false,
  deliveryFeedback: false,
  multipleAccounts: false,
  historicalBackfill: false,
  externalEffect: false,
  replyCorrelation: false,
  complaintFeedback: false,
  unsubscribeFeedback: false,
  optOutFeedback: false,
  reconsentFeedback: false,
  consentWindowEligibility: false,
};

function freezeDescriptor(raw: unknown): ConnectorDescriptor {
  const parsed = connectorDescriptorSchema.parse(raw);
  Object.freeze(parsed.authorizationScopes);
  Object.freeze(parsed.capabilities);
  Object.freeze(parsed.supportedRuntimeModes);
  Object.freeze(parsed.constraints);
  return Object.freeze(parsed);
}

export const xLegacyDmDescriptor = freezeDescriptor({
  schemaVersion: '1',
  connectorId: X_LEGACY_DM_CONNECTOR_ID,
  descriptorVersion: '1.0.0',
  provider: 'x',
  channel: 'direct-message',
  connectionStrategy: 'oauth',
  authorizationAudience: X_OAUTH_AUDIENCE,
  authorizationScopes: X_LEGACY_DM_SCOPES,
  capabilities: {
    ...disabledCapabilities,
    read: true,
    poll: true,
    threads: true,
    multipleAccounts: true,
    historicalBackfill: true,
    replyCorrelation: true,
  },
  supportedRuntimeModes: ['fixture', 'blocked_external_access', 'disabled'],
  constraints: [
    'Only the legacy unencrypted v2 DM lookup surface is modeled for bounded fixture polling.',
    'Lookup history is limited to the provider recent-history horizon of at most 30 days.',
    'Live entitlement checks, reads, sends, webhook registration, and spend are disabled.',
    'Manage requests are effect artifacts only and cannot execute provider calls.',
  ],
});

export const xChatEncryptedDescriptor = freezeDescriptor({
  schemaVersion: '1',
  connectorId: XCHAT_ENCRYPTED_CONNECTOR_ID,
  descriptorVersion: '1.0.0',
  provider: 'x',
  channel: 'encrypted-chat',
  connectionStrategy: 'external',
  authorizationScopes: [],
  capabilities: disabledCapabilities,
  supportedRuntimeModes: ['blocked_external_access', 'disabled'],
  constraints: [
    'Encrypted XChat entitlement is not proven.',
    'Legacy DM OAuth scopes, lookup endpoints, cursors, history, and send claims never apply to XChat.',
    'Only recorded chat.* activity-event namespace parsing is available; live read, history, send, webhook, and entitlement checks are blocked.',
  ],
});

export type CapabilityEvidence =
  | { readonly state: 'supported'; readonly evidence: string }
  | { readonly state: 'blocked'; readonly reason: string }
  | { readonly state: 'unknown'; readonly reason: string };

export const xLegacyDmCapabilityEvidence = Object.freeze({
  lookup: {
    state: 'supported',
    evidence: 'recorded_provider_shaped_fixture_v1',
  },
  manage: {
    state: 'blocked',
    reason: 'external_effects_disabled',
  },
  delivery: {
    state: 'unknown',
    reason: 'legacy DM create response is provider acceptance, not delivery',
  },
  webhookEntitlement: {
    state: 'unknown',
    reason: 'exact account Activity API access has not been checked',
  },
} satisfies Readonly<Record<string, CapabilityEvidence>>);

export const xChatEncryptedCapabilityEvidence = Object.freeze({
  entitlement: {
    state: 'blocked',
    reason: 'no approved encrypted XChat access evidence',
  },
  read: {
    state: 'unknown',
    reason: 'no documented account-specific encrypted read contract is proven',
  },
  history: {
    state: 'unknown',
    reason: 'legacy v2 DM history does not establish encrypted XChat history',
  },
  send: {
    state: 'unknown',
    reason: 'legacy v2 DM manage does not establish encrypted XChat send',
  },
} satisfies Readonly<Record<string, CapabilityEvidence>>);

import { connectorDescriptorSchema } from '@chief/contracts/connectors';

import {
  GRAPH_AUTHORIZATION_AUDIENCE,
  GRAPH_DELEGATED_SCOPES,
} from './oauth.js';

export const microsoftGraphFixtureDescriptor = connectorDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'microsoft-graph',
  descriptorVersion: '1.0.0-wave1a',
  provider: 'microsoft',
  channel: 'email',
  connectionStrategy: 'oauth',
  authorizationAudience: GRAPH_AUTHORIZATION_AUDIENCE,
  authorizationScopes: [...GRAPH_DELEGATED_SCOPES],
  capabilities: {
    read: true,
    send: true,
    webhook: true,
    poll: true,
    threads: true,
    attachments: true,
    deliveryFeedback: false,
    multipleAccounts: true,
    historicalBackfill: true,
    externalEffect: true,
    replyCorrelation: true,
    complaintFeedback: false,
    unsubscribeFeedback: false,
    optOutFeedback: false,
    reconsentFeedback: false,
    consentWindowEligibility: false,
  },
  supportedRuntimeModes: ['virtual_test', 'disabled'],
  constraints: [
    'Provider-shaped, credentialless, networkless Wave 1A fixture only.',
    'Selection remains unselected_candidate and release runtime remains disabled.',
    'Graph 202 is provider acceptance, never delivery.',
    'No complaint, unsubscribe, opt-out, reconsent, or delivery receipt is claimed.',
  ],
});

import { connectorDescriptorSchema } from '@chief/contracts/connectors';

const descriptor = connectorDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'microsoft-graph',
  descriptorVersion: '1.0.0-scaffold',
  provider: 'microsoft',
  channel: 'email',
  connectionStrategy: 'oauth',
  authorizationAudience: 'https://graph.microsoft.com/',
  authorizationScopes: [
    'offline_access',
    'User.Read',
    'Mail.Read',
    'Mail.Send',
  ],
  capabilities: {
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
  },
  supportedRuntimeModes: ['disabled'],
  constraints: [
    'Unselected candidate scaffold; live capability requires the release-bound Graph evidence chain.',
  ],
});
export const microsoftGraphConnectorMetadata = Object.freeze({
  ...descriptor,
  authorizationScopes: Object.freeze([...descriptor.authorizationScopes]),
  capabilities: Object.freeze({ ...descriptor.capabilities }),
  supportedRuntimeModes: Object.freeze([...descriptor.supportedRuntimeModes]),
  constraints: Object.freeze([...descriptor.constraints]),
});

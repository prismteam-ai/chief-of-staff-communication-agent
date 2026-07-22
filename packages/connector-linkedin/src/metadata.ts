import { connectorDescriptorSchema } from '@chief/contracts/connectors';
const descriptor = connectorDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'linkedin-communications',
  descriptorVersion: '1.0.0-scaffold',
  provider: 'linkedin',
  channel: 'message',
  connectionStrategy: 'external',
  authorizationScopes: [],
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
  supportedRuntimeModes: ['blocked_external_access', 'disabled'],
  constraints: [
    'Live inbox access requires approved LinkedIn Communication API entitlement; scraping is not supported.',
  ],
});
export const linkedinConnectorMetadata = Object.freeze({
  ...descriptor,
  authorizationScopes: Object.freeze([...descriptor.authorizationScopes]),
  capabilities: Object.freeze({ ...descriptor.capabilities }),
  supportedRuntimeModes: Object.freeze([...descriptor.supportedRuntimeModes]),
  constraints: Object.freeze([...descriptor.constraints]),
});

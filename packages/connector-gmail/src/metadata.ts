import { connectorDescriptorSchema } from '@chief/contracts/connectors';

const descriptor = connectorDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'gmail',
  descriptorVersion: '1.0.0-scaffold',
  provider: 'google',
  channel: 'email',
  connectionStrategy: 'oauth',
  authorizationAudience: 'https://gmail.googleapis.com/',
  authorizationScopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
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
    'Scaffold metadata only; no authorization, connection, read, or send implementation is present.',
  ],
});

export const gmailConnectorMetadata = Object.freeze({
  ...descriptor,
  authorizationScopes: Object.freeze([...descriptor.authorizationScopes]),
  capabilities: Object.freeze({ ...descriptor.capabilities }),
  supportedRuntimeModes: Object.freeze([...descriptor.supportedRuntimeModes]),
  constraints: Object.freeze([...descriptor.constraints]),
});

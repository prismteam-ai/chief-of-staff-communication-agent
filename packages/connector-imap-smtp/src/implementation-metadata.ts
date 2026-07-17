import { connectorDescriptorSchema } from '@chief/contracts/connectors';

const descriptor = connectorDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: 'imap-smtp',
  descriptorVersion: '1.0.0-protocol',
  provider: 'generic-imap-smtp',
  channel: 'email',
  connectionStrategy: 'credential',
  credentialReferenceClass: 'kms-envelope-mailbox-credential',
  authorizationScopes: [],
  capabilities: {
    read: true,
    send: true,
    webhook: false,
    poll: true,
    threads: true,
    attachments: true,
    deliveryFeedback: true,
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
  supportedRuntimeModes: ['live', 'fixture', 'disabled'],
  constraints: [
    'Selection state remains fallback_candidate and runtime remains disabled until current release-bound live certification exists.',
    'Strict TLS with certificate and hostname validation is mandatory; plaintext authentication and TLS downgrade are forbidden.',
    'Threads are reconstructed from RFC Message-ID, In-Reply-To, and References headers and are not provider-native.',
    'SMTP final acceptance is not delivery; only provider-exposed DSN feedback may advance delivery or bounce facts.',
    'Inconclusive SMTP completion is acceptance_unknown and cannot enter ordinary retry.',
  ],
});

export const imapSmtpImplementationDescriptor = Object.freeze({
  ...descriptor,
  authorizationScopes: Object.freeze([...descriptor.authorizationScopes]),
  capabilities: Object.freeze({ ...descriptor.capabilities }),
  supportedRuntimeModes: Object.freeze([...descriptor.supportedRuntimeModes]),
  constraints: Object.freeze([...descriptor.constraints]),
});

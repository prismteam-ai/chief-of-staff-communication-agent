import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import type { ConnectorDescriptor } from '@chief/contracts/connectors';

export type TwilioChannel = 'sms' | 'whatsapp';

function freezeDescriptor(input: unknown): Readonly<ConnectorDescriptor> {
  const descriptor = connectorDescriptorSchema.parse(input);
  return Object.freeze({
    ...descriptor,
    authorizationScopes: Object.freeze([
      ...descriptor.authorizationScopes,
    ]) as unknown as string[],
    capabilities: Object.freeze({ ...descriptor.capabilities }),
    supportedRuntimeModes: Object.freeze([
      ...descriptor.supportedRuntimeModes,
    ]) as unknown as ConnectorDescriptor['supportedRuntimeModes'],
    constraints: Object.freeze([
      ...descriptor.constraints,
    ]) as unknown as string[],
  });
}

export const twilioSmsDescriptor = freezeDescriptor({
  schemaVersion: '1',
  connectorId: 'twilio-sms',
  descriptorVersion: '1.0.0',
  provider: 'twilio',
  channel: 'sms',
  connectionStrategy: 'credential',
  credentialReferenceClass: 'secrets-manager-twilio-account-credential',
  authorizationScopes: [],
  capabilities: {
    read: false,
    send: false,
    webhook: true,
    poll: false,
    threads: false,
    attachments: true,
    deliveryFeedback: true,
    multipleAccounts: true,
    historicalBackfill: false,
    externalEffect: false,
    replyCorrelation: true,
    complaintFeedback: false,
    unsubscribeFeedback: false,
    optOutFeedback: true,
    reconsentFeedback: true,
    consentWindowEligibility: false,
  },
  supportedRuntimeModes: ['live_trial', 'virtual_test', 'disabled'],
  constraints: [
    'Inbound and callback handling only; provider reads and external sends are disabled.',
    'Trial recipients and sender restrictions remain provider-account facts and are not inferred.',
    'SMS opt-out state is allowed only from provider-visible OptOutType evidence.',
  ],
});

export const twilioWhatsAppDescriptor = freezeDescriptor({
  schemaVersion: '1',
  connectorId: 'twilio-whatsapp',
  descriptorVersion: '1.0.0',
  provider: 'twilio',
  channel: 'whatsapp',
  connectionStrategy: 'credential',
  credentialReferenceClass: 'secrets-manager-twilio-account-credential',
  authorizationScopes: [],
  capabilities: {
    read: false,
    send: false,
    webhook: true,
    poll: false,
    threads: false,
    attachments: true,
    deliveryFeedback: true,
    multipleAccounts: true,
    historicalBackfill: false,
    externalEffect: false,
    replyCorrelation: true,
    complaintFeedback: false,
    unsubscribeFeedback: false,
    optOutFeedback: true,
    reconsentFeedback: true,
    consentWindowEligibility: true,
  },
  supportedRuntimeModes: ['sandbox', 'virtual_test', 'disabled'],
  constraints: [
    'Sandbox join state is external account evidence and is never inferred from a fixture.',
    'Free-form replies require verified opt-in and an open 24-hour customer-service window.',
    'Outside the window, only a separately approved template is eligible.',
    'Provider reads and external sends are disabled.',
  ],
});

export const twilioDescriptors = Object.freeze({
  sms: twilioSmsDescriptor,
  whatsapp: twilioWhatsAppDescriptor,
});

export const twilioUnsupportedFacts = Object.freeze({
  smsHistoricalBackfill: Object.freeze({
    state: 'unknown' as const,
    reason: 'no live Twilio message-list entitlement or bounded history proof',
  }),
  whatsappSandboxMembership: Object.freeze({
    state: 'unknown' as const,
    reason:
      'sandbox join is provider-account state and fixtures cannot prove it',
  }),
  deliveryTimestamp: Object.freeze({
    state: 'unknown' as const,
    reason:
      'status callbacks do not universally provide a provider event timestamp',
  }),
});

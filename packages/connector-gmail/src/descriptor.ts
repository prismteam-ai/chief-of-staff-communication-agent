import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import type { ConnectorDescriptor } from '@chief/contracts/connectors';

export const GMAIL_CONNECTOR_ID = 'gmail';
export const GMAIL_DESCRIPTOR_VERSION = '1.0.0';
export const GMAIL_AUTHORIZATION_AUDIENCE = 'https://gmail.googleapis.com/';
export const GMAIL_READ_ONLY_OAUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
] as const);
export const GMAIL_OAUTH_SCOPES = Object.freeze([
  ...GMAIL_READ_ONLY_OAUTH_SCOPES,
  'https://www.googleapis.com/auth/gmail.send',
] as const);

const descriptor = connectorDescriptorSchema.parse({
  schemaVersion: '1',
  connectorId: GMAIL_CONNECTOR_ID,
  descriptorVersion: GMAIL_DESCRIPTOR_VERSION,
  provider: 'google',
  channel: 'email',
  connectionStrategy: 'oauth',
  authorizationAudience: GMAIL_AUTHORIZATION_AUDIENCE,
  authorizationScopes: [...GMAIL_OAUTH_SCOPES],
  capabilities: {
    read: true,
    send: true,
    webhook: false,
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
  supportedRuntimeModes: ['live', 'fixture', 'disabled'],
  constraints: [
    'Inbound synchronization requires fenced Gmail history.list polling and bounded backfill.',
    'Pub/Sub watch is independently disabled until hosted IAM, renewal, verification, and gap-recovery proof exists.',
    'Gmail API acceptance is not delivery; universal delivery, complaint, unsubscribe, and bounce feedback are unsupported.',
    'Ambiguous sends use bounded Sent-mail reconciliation and never enter ordinary retry.',
  ],
});

export function gmailConnectorDescriptor(): ConnectorDescriptor {
  return connectorDescriptorSchema.parse(descriptor);
}

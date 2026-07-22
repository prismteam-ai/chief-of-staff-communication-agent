import {
  connectorAccountSchema,
  connectorSnapshotSchema,
  credentialConnectionInputSchema,
} from '@chief/contracts/connectors';
import type {
  ConnectorAccount,
  CredentialConnectionInput,
} from '@chief/contracts/connectors';
import { keyedDigestValueSchema } from '@chief/contracts/ids';

import { imapSmtpImplementationDescriptor } from './implementation-metadata.js';

export function createDisabledImapSmtpAccount(inputValue: {
  readonly input: CredentialConnectionInput;
  readonly accountId: string;
  readonly capabilitySnapshotHash: string;
  readonly providerAccountDigest: string;
  readonly observedAt: string;
}): ConnectorAccount {
  const input = credentialConnectionInputSchema.parse(inputValue.input);
  if (input.connectorId !== imapSmtpImplementationDescriptor.connectorId) {
    throw new Error('IMAP_SMTP_CONNECTOR_ID_MISMATCH');
  }
  if (
    input.credentialClass !==
    imapSmtpImplementationDescriptor.credentialReferenceClass
  ) {
    throw new Error('IMAP_SMTP_CREDENTIAL_CLASS_MISMATCH');
  }
  if (
    input.secretReference.includes('@') ||
    /(?:password|token|secret)=/iu.test(input.secretReference)
  ) {
    throw new Error('IMAP_SMTP_OPAQUE_SECRET_REFERENCE_REQUIRED');
  }
  const snapshot = connectorSnapshotSchema.parse({
    connectorId: imapSmtpImplementationDescriptor.connectorId,
    descriptorVersion: imapSmtpImplementationDescriptor.descriptorVersion,
    accountId: inputValue.accountId,
    capabilitySnapshotHash: inputValue.capabilitySnapshotHash,
    runtimeMode: 'disabled',
    selectionState: 'fallback_candidate',
  });
  return connectorAccountSchema.parse({
    tenantId: input.tenantId,
    accountId: inputValue.accountId,
    ownerUserId: input.userId,
    provider: imapSmtpImplementationDescriptor.provider,
    channel: imapSmtpImplementationDescriptor.channel,
    providerAccountDigest: keyedDigestValueSchema.parse(
      inputValue.providerAccountDigest,
    ),
    displayLabel: 'Generic IMAP/SMTP mailbox (disabled candidate)',
    snapshot,
    status: 'disabled',
    health: 'unknown',
    stateVersion: 1,
    updatedAt: inputValue.observedAt,
  });
}

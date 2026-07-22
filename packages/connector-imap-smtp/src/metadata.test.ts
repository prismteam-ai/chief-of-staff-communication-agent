import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { imapSmtpConnectorMetadata } from './metadata.js';
describe('IMAP/SMTP scaffold metadata', () => {
  it('is credential-shaped but disabled and non-effectful', () => {
    expect(
      connectorDescriptorSchema.parse(imapSmtpConnectorMetadata),
    ).toBeTruthy();
    expect(imapSmtpConnectorMetadata.connectionStrategy).toBe('credential');
    expect(imapSmtpConnectorMetadata.capabilities.send).toBe(false);
    expect(imapSmtpConnectorMetadata.capabilities.externalEffect).toBe(false);
  });
});

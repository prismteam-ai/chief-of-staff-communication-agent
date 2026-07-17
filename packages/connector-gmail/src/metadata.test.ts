import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { gmailConnectorMetadata } from './metadata.js';

describe('Gmail scaffold metadata', () => {
  it('is immutable, schema-valid, and does not claim a working effect', () => {
    expect(
      connectorDescriptorSchema.parse(gmailConnectorMetadata),
    ).toBeTruthy();
    expect(Object.isFrozen(gmailConnectorMetadata)).toBe(true);
    expect(gmailConnectorMetadata.capabilities).toMatchObject({
      read: false,
      send: false,
      externalEffect: false,
    });
    expect(gmailConnectorMetadata.supportedRuntimeModes).toEqual(['disabled']);
  });
});

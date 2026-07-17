import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { gmailConnectorMetadata } from './metadata.js';

describe('Gmail implementation metadata', () => {
  it('is immutable, schema-valid, and mirrors the real connector', () => {
    expect(
      connectorDescriptorSchema.parse(gmailConnectorMetadata),
    ).toBeTruthy();
    expect(Object.isFrozen(gmailConnectorMetadata)).toBe(true);
    expect(gmailConnectorMetadata.capabilities).toMatchObject({
      read: true,
      send: true,
      poll: true,
      historicalBackfill: true,
      externalEffect: true,
    });
    expect(gmailConnectorMetadata.supportedRuntimeModes).toEqual([
      'live',
      'fixture',
      'disabled',
    ]);
  });
});

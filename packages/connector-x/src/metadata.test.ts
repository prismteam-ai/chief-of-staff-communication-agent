import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { xConnectorMetadata } from './metadata.js';
describe('X scaffold metadata', () => {
  it('is immutable disabled metadata without entitlement claims', () => {
    expect(connectorDescriptorSchema.parse(xConnectorMetadata)).toBeTruthy();
    expect(Object.isFrozen(xConnectorMetadata)).toBe(true);
    expect(xConnectorMetadata.capabilities).toMatchObject({
      read: false,
      send: false,
      externalEffect: false,
    });
  });
});

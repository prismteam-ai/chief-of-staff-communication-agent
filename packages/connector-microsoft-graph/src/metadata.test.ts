import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { microsoftGraphConnectorMetadata } from './metadata.js';
describe('Microsoft Graph scaffold metadata', () => {
  it('remains a disabled non-effect candidate', () => {
    expect(
      connectorDescriptorSchema.parse(microsoftGraphConnectorMetadata),
    ).toBeTruthy();
    expect(Object.isFrozen(microsoftGraphConnectorMetadata)).toBe(true);
    expect(microsoftGraphConnectorMetadata.capabilities.externalEffect).toBe(
      false,
    );
    expect(microsoftGraphConnectorMetadata.supportedRuntimeModes).toEqual([
      'disabled',
    ]);
  });
});

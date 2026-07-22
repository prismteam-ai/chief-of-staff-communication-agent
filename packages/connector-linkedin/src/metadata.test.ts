import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { linkedinConnectorMetadata } from './metadata.js';
describe('LinkedIn scaffold metadata', () => {
  it('truthfully reports blocked external access and no effects', () => {
    expect(
      connectorDescriptorSchema.parse(linkedinConnectorMetadata),
    ).toBeTruthy();
    expect(linkedinConnectorMetadata.connectionStrategy).toBe('external');
    expect(linkedinConnectorMetadata.supportedRuntimeModes).toContain(
      'blocked_external_access',
    );
    expect(linkedinConnectorMetadata.capabilities.externalEffect).toBe(false);
  });
});

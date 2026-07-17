import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';
import { twilioConnectorMetadata } from './metadata.js';
describe('Twilio scaffold metadata', () => {
  it('does not advertise sandbox, send, or feedback before implementation', () => {
    expect(
      connectorDescriptorSchema.parse(twilioConnectorMetadata),
    ).toBeTruthy();
    expect(twilioConnectorMetadata.supportedRuntimeModes).toEqual(['disabled']);
    expect(twilioConnectorMetadata.capabilities).toMatchObject({
      send: false,
      webhook: false,
      deliveryFeedback: false,
      externalEffect: false,
    });
  });
});

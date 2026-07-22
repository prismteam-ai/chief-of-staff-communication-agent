import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import { describe, expect, it } from 'vitest';

import {
  X_LEGACY_DM_SCOPES,
  xChatEncryptedCapabilityEvidence,
  xChatEncryptedDescriptor,
  xLegacyDmCapabilityEvidence,
  xLegacyDmDescriptor,
} from './implementation-metadata.js';

describe('X capability implementation metadata', () => {
  it('keeps legacy DM and encrypted XChat descriptors independent', () => {
    expect(connectorDescriptorSchema.parse(xLegacyDmDescriptor)).toBeTruthy();
    expect(
      connectorDescriptorSchema.parse(xChatEncryptedDescriptor),
    ).toBeTruthy();
    expect(xLegacyDmDescriptor.connectorId).toBe('x_legacy_dm');
    expect(xChatEncryptedDescriptor.connectorId).toBe('xchat_encrypted');
    expect(xLegacyDmDescriptor.authorizationScopes).toEqual(X_LEGACY_DM_SCOPES);
    expect(xChatEncryptedDescriptor.authorizationScopes).toEqual([]);
    expect(xLegacyDmDescriptor.supportedRuntimeModes).toContain('fixture');
    expect(xChatEncryptedDescriptor.supportedRuntimeModes).toEqual([
      'blocked_external_access',
      'disabled',
    ]);
  });

  it('never claims a live external effect', () => {
    expect(xLegacyDmDescriptor.capabilities).toMatchObject({
      read: true,
      poll: true,
      send: false,
      webhook: false,
      externalEffect: false,
    });
    expect(xChatEncryptedDescriptor.capabilities).toMatchObject({
      read: false,
      poll: false,
      send: false,
      webhook: false,
      externalEffect: false,
    });
  });

  it('types unproven provider facts as unknown or blocked', () => {
    expect(xLegacyDmCapabilityEvidence.delivery.state).toBe('unknown');
    expect(xLegacyDmCapabilityEvidence.webhookEntitlement.state).toBe(
      'unknown',
    );
    expect(xChatEncryptedCapabilityEvidence.entitlement.state).toBe('blocked');
    expect(xChatEncryptedCapabilityEvidence.history.state).toBe('unknown');
    expect(xChatEncryptedCapabilityEvidence.send.state).toBe('unknown');
  });
});

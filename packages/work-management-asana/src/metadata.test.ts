import { describe, expect, it } from 'vitest';
import { workManagementDescriptorSchema } from '@chief/contracts/connectors';
import { asanaWorkManagementMetadata } from './metadata.js';
describe('Asana scaffold metadata', () => {
  it('is canonical work-management-only immutable metadata', () => {
    expect(
      workManagementDescriptorSchema.parse(asanaWorkManagementMetadata),
    ).toEqual(asanaWorkManagementMetadata);
    expect(Object.isFrozen(asanaWorkManagementMetadata)).toBe(true);
    expect(Object.isFrozen(asanaWorkManagementMetadata.capabilities)).toBe(
      true,
    );
    expect(asanaWorkManagementMetadata).not.toHaveProperty('channel');
    expect(asanaWorkManagementMetadata.capabilities).not.toHaveProperty('send');
    expect(asanaWorkManagementMetadata.capabilities.createTask).toBe(false);
    expect(asanaWorkManagementMetadata.capabilities.updateTask).toBe(false);
    expect(asanaWorkManagementMetadata.capabilities.createComment).toBe(false);
    expect(asanaWorkManagementMetadata.capabilities.webhooks).toBe(false);
    expect(asanaWorkManagementMetadata.capabilities.externalEffect).toBe(false);
    expect(asanaWorkManagementMetadata.supportedRuntimeModes).toEqual([
      'disabled',
    ]);
  });
});

import { createHash } from 'node:crypto';

import type { ExternalCommunicationConnector } from '@chief/connector-core';
import { connectorDescriptorSchema } from '@chief/contracts/connectors';
import type { ConnectorAccountRef } from '@chief/contracts/connectors';

import { linkedinConnectorMetadata } from './metadata.js';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const LINKEDIN_CAPABILITY_SNAPSHOT_HASH = createHash('sha256')
  .update(
    stableJson({
      descriptorVersion: linkedinConnectorMetadata.descriptorVersion,
      capabilities: linkedinConnectorMetadata.capabilities,
      supportedRuntimeModes: linkedinConnectorMetadata.supportedRuntimeModes,
    }),
  )
  .digest('hex');

export interface LinkedinBlockedConnectorOptions {
  readonly observedAt?: string;
  readonly capabilitySnapshotHash?: string;
}

export function createLinkedinBlockedConnector(
  options: LinkedinBlockedConnectorOptions = {},
): ExternalCommunicationConnector {
  const observedAt = options.observedAt ?? '2026-07-17T00:00:00.000Z';
  const capabilitySnapshotHash =
    options.capabilitySnapshotHash ?? LINKEDIN_CAPABILITY_SNAPSHOT_HASH;

  return Object.freeze({
    connectorKind: 'communication' as const,
    descriptor: () =>
      connectorDescriptorSchema.parse(linkedinConnectorMetadata),
    authorizationStrategy: () => ({ strategy: 'external' as const }),
    validateConnection: (account: ConnectorAccountRef) =>
      Promise.resolve({
        account,
        health: 'failed' as const,
        observedAt,
        capabilitySnapshotHash,
        errorCode: 'LINKEDIN_COMMUNICATION_API_ENTITLEMENT_NOT_PROVEN',
      }),
  });
}

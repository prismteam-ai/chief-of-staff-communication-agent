import {
  assertCommunicationConnectorContract,
  createConnectorContractFixtures,
} from '@chief/connector-testkit';
import { describe, expect, it } from 'vitest';

import {
  createLinkedinBlockedConnector,
  LINKEDIN_CAPABILITY_SNAPSHOT_HASH,
} from './connector.js';
import { linkedinExternalAccessStatus } from './implementation-metadata.js';

describe('LinkedIn blocked connector contract', () => {
  it('passes the frozen communication contract while keeping every external surface absent', async () => {
    const fixtures = createConnectorContractFixtures();
    expect(fixtures.descriptor.connectorId).toBe('test-communication');
    expect(fixtures.snapshot.runtimeMode).toBe('live');
    const connector = createLinkedinBlockedConnector({
      observedAt: fixtures.account.updatedAt,
      capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
    });

    // The generic live/effect fixture exercises frozen runner controls only.
    // It is not LinkedIn runtime, entitlement, provider, or release evidence.
    expect(connector.descriptor().connectorId).toBe('linkedin-communications');
    expect(connector.descriptor().supportedRuntimeModes).toEqual([
      'blocked_external_access',
      'disabled',
    ]);
    expect(connector.descriptor().capabilities).toEqual(
      expect.objectContaining({
        read: false,
        send: false,
        webhook: false,
        poll: false,
        externalEffect: false,
      }),
    );

    const report = await assertCommunicationConnectorContract(
      connector,
      fixtures,
    );

    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThan(10);
    expect(connector.authorizationStrategy()).toEqual({ strategy: 'external' });
    expect(connector).not.toHaveProperty('beginAuthorization');
    expect(connector).not.toHaveProperty('completeAuthorization');
    expect(connector).not.toHaveProperty('poll');
    expect(connector).not.toHaveProperty('fetchMessage');
    expect(connector).not.toHaveProperty('fetchThread');
    expect(connector).not.toHaveProperty('send');
    expect(connector).not.toHaveProperty('reconcileSend');
    expect(connector).not.toHaveProperty('verifyWebhook');
    expect(connector).not.toHaveProperty('subscribe');
    expect(linkedinExternalAccessStatus).toMatchObject({
      state: 'blocked_external_access',
      externalEffects: 'disabled',
      inboxRead: 'unknown',
      send: 'unknown',
      archiveImport: 'read_only_independent_capability',
    });
  });

  it('reports an account-bound failed health fact without probing LinkedIn', async () => {
    const fixtures = createConnectorContractFixtures();
    const connector = createLinkedinBlockedConnector({
      observedAt: fixtures.account.updatedAt,
    });

    await expect(
      connector.validateConnection(fixtures.accountRef),
    ).resolves.toEqual({
      account: fixtures.accountRef,
      health: 'failed',
      observedAt: fixtures.account.updatedAt,
      capabilitySnapshotHash: LINKEDIN_CAPABILITY_SNAPSHOT_HASH,
      errorCode: 'LINKEDIN_COMMUNICATION_API_ENTITLEMENT_NOT_PROVEN',
    });
  });
});

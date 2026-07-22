import { describe, expect, it } from 'vitest';

import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
  subscriptionMutationRequestSchema,
} from '@chief/contracts/connectors';

import type {
  CommunicationConnector,
  WorkManagementConnector,
} from '@chief/connector-core';
import {
  assertSubscriptionMutationFence,
  communicationConnectorIssues,
  ConnectorRuntimeRegistry,
  dispatchCommunicationEffect,
  verifyAndNormalizeWebhook,
  workManagementConnectorIssues,
} from '@chief/connector-core';

import { createDeliberatelyBrokenAdapter } from './broken-adapter.js';
import {
  createDeterministicConnector,
  ExactFixtureArtifactAuthority,
  InMemoryEffectPersistence,
  RecordingVerifiedEventPersistence,
} from './fakes.js';
import {
  assertCommunicationConnectorContract,
  runCommunicationConnectorContract,
  runWorkManagementConnectorContract,
} from './contract-runner.js';
import {
  createConnectorContractFixtures,
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_LATER,
} from './fixtures.js';

describe('communication connector contract runner', () => {
  it('passes the complete deterministic provider boundary', async () => {
    const fixtures = createConnectorContractFixtures();
    const connector = createDeterministicConnector(fixtures).connector;

    const report = await assertCommunicationConnectorContract(
      connector,
      fixtures,
    );

    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(12);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it('passes a capability-minimal connector and exercises disabled paths', async () => {
    const fixtures = createConnectorContractFixtures();
    const full = createDeterministicConnector(fixtures).connector;
    const passive = {
      ...full,
      descriptor: () => ({
        ...fixtures.descriptor,
        capabilities: Object.fromEntries(
          Object.keys(fixtures.descriptor.capabilities).map((name) => [
            name,
            false,
          ]),
        ),
      }),
      fetchMessage: undefined,
      fetchThread: undefined,
      poll: undefined,
      subscribe: undefined,
      renewSubscription: undefined,
      verifyWebhook: undefined,
      normalizeInboundEvent: undefined,
      parseFeedbackEvent: undefined,
      send: undefined,
      reconcileSend: undefined,
    } as unknown as CommunicationConnector;

    await expect(
      runCommunicationConnectorContract(passive, fixtures),
    ).resolves.toMatchObject({ passed: true });
  });

  it('fails the reusable suite on a schema-valid cross-account message fact', async () => {
    const fixtures = createConnectorContractFixtures();
    const full = createDeterministicConnector(fixtures).connector;
    const fetchMessage = full.fetchMessage;
    expect(fetchMessage).toBeDefined();
    const substitutedAccount = connectorAccountRefSchema.parse({
      ...fixtures.accountRef,
      accountId: 'account-substituted',
    });
    const crossAccount = {
      ...full,
      fetchMessage: async (
        ...args: Parameters<NonNullable<typeof fetchMessage>>
      ) => ({
        ...(await fetchMessage!(...args)),
        account: substitutedAccount,
      }),
    } as CommunicationConnector;

    const report = await runCommunicationConnectorContract(
      crossAccount,
      fixtures,
    );

    expect(report.passed).toBe(false);
    expect(
      report.checks.find(
        (check) => check.name === 'adapters return canonical provider facts',
      )?.detail,
    ).toContain('PROVIDER_FACT_BINDING_MISMATCH');
  });

  it('proves the suite rejects a deliberately broken adapter', async () => {
    const fixtures = createConnectorContractFixtures();
    const broken = createDeliberatelyBrokenAdapter(fixtures);

    const report = await runCommunicationConnectorContract(broken, fixtures);

    expect(report.passed).toBe(false);
    expect(
      report.checks.find(
        (check) => check.name === 'descriptor and method parity',
      )?.passed,
    ).toBe(false);
    expect(
      report.checks.find(
        (check) =>
          check.name ===
          'webhook verification precedes persistence and normalization',
      )?.passed,
    ).toBe(false);
    await expect(
      assertCommunicationConnectorContract(broken, fixtures),
    ).rejects.toThrow(/reconcileSend|normalized/u);
  });

  it('rejects no-op OAuth methods on a non-OAuth strategy', () => {
    const fixtures = createConnectorContractFixtures();
    const connector = createDeterministicConnector(fixtures).connector;
    const drifted = {
      ...connector,
      beginAuthorization: () =>
        Promise.resolve({
          authorizationUrl: 'https://example.invalid/oauth',
          stateDigest: FIXTURE_HASH,
          expiresAt: FIXTURE_LATER,
        }),
      completeAuthorization: () => Promise.resolve(fixtures.account),
    } as unknown as CommunicationConnector;

    expect(communicationConnectorIssues(drifted)).toContain(
      'none strategy forbids oauth and credential methods',
    );
  });

  it('runs webhook verification before durable raw-event persistence and normalization', async () => {
    const fixtures = createConnectorContractFixtures();
    const control = createDeterministicConnector(fixtures);
    const persistence = new RecordingVerifiedEventPersistence(
      fixtures.verifiedEvent,
      control.calls.order,
    );

    await verifyAndNormalizeWebhook(
      control.connector,
      persistence,
      fixtures.webhookRequest,
    );

    expect(control.calls.order).toEqual([
      'verify',
      'persist_verified',
      'normalize',
    ]);
  });

  it('fails closed when external effects or runtime mode are disabled', async () => {
    const fixtures = createConnectorContractFixtures();
    const control = createDeterministicConnector(fixtures);
    const disabled = {
      ...control.connector,
      descriptor: () => ({
        ...fixtures.descriptor,
        capabilities: {
          ...fixtures.descriptor.capabilities,
          externalEffect: false,
        },
      }),
    } as CommunicationConnector;
    expect(communicationConnectorIssues(disabled)).toContain(
      'communication send and externalEffect capabilities must remain truthful',
    );
    await expect(
      dispatchCommunicationEffect(
        disabled,
        new InMemoryEffectPersistence(),
        new ExactFixtureArtifactAuthority(fixtures.artifact),
        fixtures.accountRef,
        fixtures.artifact,
        fixtures.snapshot,
      ),
    ).rejects.toThrow('EXTERNAL_EFFECT_CAPABILITY_DISABLED');

    const fixtureSnapshot = connectorSnapshotSchema.parse({
      ...fixtures.snapshot,
      runtimeMode: 'fixture',
    });
    await expect(
      dispatchCommunicationEffect(
        control.connector,
        new InMemoryEffectPersistence(),
        new ExactFixtureArtifactAuthority(fixtures.artifact),
        fixtures.accountRef,
        { ...fixtures.artifact, connectorSnapshot: fixtureSnapshot },
        fixtureSnapshot,
      ),
    ).rejects.toThrow('EXTERNAL_EFFECT_CAPABILITY_DISABLED');
    expect(control.calls.sendCount).toBe(0);
  });

  it('uses a conditional dispatch claim under concurrent delivery', async () => {
    const fixtures = createConnectorContractFixtures();
    const control = createDeterministicConnector(fixtures);
    const persistence = new InMemoryEffectPersistence();
    const authority = new ExactFixtureArtifactAuthority(fixtures.artifact);

    const results = await Promise.all([
      dispatchCommunicationEffect(
        control.connector,
        persistence,
        authority,
        fixtures.accountRef,
        fixtures.artifact,
        fixtures.snapshot,
      ),
      dispatchCommunicationEffect(
        control.connector,
        persistence,
        authority,
        fixtures.accountRef,
        fixtures.artifact,
        fixtures.snapshot,
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'contended',
      'settled',
    ]);
    expect(control.calls.sendCount).toBe(1);
  });

  it('awaits asynchronous authority immediately before the adapter effect', async () => {
    const fixtures = createConnectorContractFixtures();
    const control = createDeterministicConnector(fixtures);
    const order = control.calls.order;

    await dispatchCommunicationEffect(
      control.connector,
      new InMemoryEffectPersistence(),
      {
        assertCurrent: async () => {
          await Promise.resolve();
          order.push('authority');
        },
      },
      fixtures.accountRef,
      fixtures.artifact,
      fixtures.snapshot,
    );

    expect(order).toEqual(['authority', 'send']);
  });

  it('rejects a subscription mutation whose pre-call claim is stale', () => {
    const fixtures = createConnectorContractFixtures();
    expect(() =>
      assertSubscriptionMutationFence(
        {
          schemaVersion: '1',
          account: fixtures.accountRef,
          resourceScopeHash: FIXTURE_HASH,
          expectedLeaseEpoch: 2,
          mutationClaim: {
            tenantId: fixtures.accountRef.tenantId,
            accountId: fixtures.accountRef.accountId,
            resourceScopeHash: FIXTURE_HASH,
            leaseEpoch: 1,
            mutationEpoch: 1,
            requestFingerprint: FIXTURE_HASH,
            owner: 'worker-a',
            expiresAt: FIXTURE_LATER,
            mutation: 'renew',
          },
          expectedClaimRequestFingerprint: FIXTURE_HASH,
          expectedMutation: 'renew',
          providerIdempotencyKey: 'renew-a',
          requestedExpiresAt: FIXTURE_LATER,
        },
        FIXTURE_LATER,
      ),
    ).toThrow('SUBSCRIPTION_MUTATION_FENCE_REJECTED');
  });

  it('compares claim expiry as an instant and binds fingerprint plus mutation', () => {
    const fixtures = createConnectorContractFixtures();
    const valid = subscriptionMutationRequestSchema.parse({
      schemaVersion: '1',
      account: fixtures.accountRef,
      resourceScopeHash: FIXTURE_HASH,
      expectedLeaseEpoch: 1,
      mutationClaim: {
        tenantId: fixtures.accountRef.tenantId,
        accountId: fixtures.accountRef.accountId,
        resourceScopeHash: FIXTURE_HASH,
        leaseEpoch: 1,
        mutationEpoch: 1,
        requestFingerprint: FIXTURE_HASH,
        owner: 'worker-a',
        expiresAt: '2026-07-17T15:00:00.000+02:00',
        mutation: 'renew',
      },
      expectedClaimRequestFingerprint: FIXTURE_HASH,
      expectedMutation: 'renew',
      providerIdempotencyKey: 'renew-a',
      requestedExpiresAt: '2026-07-17T16:00:00.000+02:00',
    });
    expect(() =>
      assertSubscriptionMutationFence(valid, '2026-07-17T12:30:00.000Z'),
    ).not.toThrow();

    const expired = subscriptionMutationRequestSchema.parse({
      ...valid,
      mutationClaim: {
        ...valid.mutationClaim,
        expiresAt: '2026-07-17T14:00:00.000+02:00',
      },
    });
    expect(() =>
      assertSubscriptionMutationFence(expired, '2026-07-17T12:30:00.000Z'),
    ).toThrow('SUBSCRIPTION_MUTATION_FENCE_REJECTED');

    const fingerprintMismatch = {
      ...valid,
      expectedClaimRequestFingerprint: FIXTURE_HASH_B,
    };
    expect(() =>
      assertSubscriptionMutationFence(
        fingerprintMismatch,
        '2026-07-17T12:30:00.000Z',
      ),
    ).toThrow('SUBSCRIPTION_MUTATION_FENCE_REJECTED');
    const mutationMismatch = { ...valid, expectedMutation: 'replace' as const };
    expect(() =>
      assertSubscriptionMutationFence(
        mutationMismatch,
        '2026-07-17T12:30:00.000Z',
      ),
    ).toThrow('SUBSCRIPTION_MUTATION_FENCE_REJECTED');
  });

  it('keeps work management in its sibling registry, never communication', async () => {
    const fixtures = createConnectorContractFixtures();
    let workEffects = 0;
    const workConnector: WorkManagementConnector = {
      connectorKind: 'work_management',
      descriptor: () => ({
        schemaVersion: '1',
        connectorId: fixtures.descriptor.connectorId,
        descriptorVersion: fixtures.descriptor.descriptorVersion,
        provider: 'asana',
        connectionStrategy: 'none',
        authorizationScopes: [],
        capabilities: {
          readTasks: true,
          readProjects: true,
          readMilestones: true,
          readComments: true,
          createTask: true,
          updateTask: true,
          createComment: true,
          webhooks: false,
          attachments: true,
          multipleAccounts: true,
          externalEffect: true,
        },
        supportedRuntimeModes: ['live'],
        constraints: ['contract-test-only'],
      }),
      authorizationStrategy: () => ({ strategy: 'none' }),
      validateConnection: (account) =>
        Promise.resolve({
          account,
          health: 'healthy',
          observedAt: FIXTURE_LATER,
          capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
        }),
      fetchObject: (_account, ref) =>
        Promise.resolve({
          kind: ref.kind,
          providerObjectId: ref.providerObjectId,
          providerVersion: '1',
          providerTimestamp: FIXTURE_LATER,
          payloadFingerprint: FIXTURE_HASH,
        }),
      execute: () => {
        workEffects += 1;
        return Promise.resolve({
          outcome: 'accepted',
          providerResponseHash: FIXTURE_HASH,
          providerCorrelation: 'asana-task-a',
          observedAt: FIXTURE_LATER,
        });
      },
      reconcileEffect: () =>
        Promise.resolve({
          outcome: 'accepted',
          providerResponseHash: FIXTURE_HASH,
          providerCorrelation: 'asana-task-a',
          observedAt: FIXTURE_LATER,
        }),
    };
    const registry = new ConnectorRuntimeRegistry();

    registry.registerWorkManagement(workConnector);

    expect(registry.workManagement(fixtures.descriptor.connectorId)).toBe(
      workConnector,
    );
    expect(() =>
      registry.communication(fixtures.descriptor.connectorId),
    ).toThrow(/communication connector not registered/u);
    await expect(
      runWorkManagementConnectorContract(workConnector, fixtures),
    ).resolves.toMatchObject({ passed: true });
    expect(workEffects).toBe(1);

    const readOnly = {
      ...workConnector,
      descriptor: () => ({
        ...workConnector.descriptor(),
        capabilities: {
          ...workConnector.descriptor().capabilities,
          createTask: false,
          updateTask: false,
          createComment: false,
          externalEffect: false,
        },
      }),
      execute: undefined,
      reconcileEffect: undefined,
    } as unknown as WorkManagementConnector;
    await expect(
      runWorkManagementConnectorContract(readOnly, fixtures),
    ).resolves.toMatchObject({ passed: true });
    expect(workEffects).toBe(1);

    const capabilityDrift = {
      ...workConnector,
      descriptor: () => ({
        ...workConnector.descriptor(),
        capabilities: {
          ...workConnector.descriptor().capabilities,
          createTask: false,
          updateTask: false,
          createComment: false,
          externalEffect: false,
        },
      }),
    } as WorkManagementConnector;
    expect(workManagementConnectorIssues(capabilityDrift)).toContain(
      'work-management mutation capabilities require execute and reconciliation parity',
    );
  });
});

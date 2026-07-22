import { describe, expect, it } from 'vitest';

import {
  connectorDescriptorSchema,
  subscriptionMutationRequestSchema,
} from '@chief/contracts/connectors';

import type { CommunicationConnector } from './communication-connector.js';
import { communicationConnectorIssues } from './runtime-registry.js';
import {
  assertSubscriptionMutationFence,
  invokeCommunicationSubscriptionMutation,
} from './subscription.js';

const hash = 'a'.repeat(64);

describe('connector core guards', () => {
  it('rejects strategy-specific methods outside their strategy', () => {
    const descriptor = connectorDescriptorSchema.parse({
      schemaVersion: '1',
      connectorId: 'broken-none',
      descriptorVersion: '1',
      provider: 'test',
      channel: 'email',
      connectionStrategy: 'none',
      authorizationScopes: [],
      capabilities: {
        read: true,
        send: false,
        webhook: false,
        poll: false,
        threads: false,
        attachments: false,
        deliveryFeedback: false,
        multipleAccounts: false,
        historicalBackfill: false,
        externalEffect: false,
        replyCorrelation: false,
        complaintFeedback: false,
        unsubscribeFeedback: false,
        optOutFeedback: false,
        reconsentFeedback: false,
        consentWindowEligibility: false,
      },
      supportedRuntimeModes: ['disabled'],
      constraints: [],
    });
    const connector = {
      connectorKind: 'communication',
      descriptor: () => descriptor,
      authorizationStrategy: () => ({ strategy: 'none' }),
      beginAuthorization: () =>
        Promise.reject(new Error('no-op OAuth method must never be callable')),
      validateConnection: () => Promise.reject(new Error('not used')),
      fetchMessage: () => Promise.reject(new Error('not used')),
    } as unknown as CommunicationConnector;

    expect(communicationConnectorIssues(connector)).toContain(
      'none strategy forbids oauth and credential methods',
    );
  });

  it('requires a pre-call subscription claim bound to the expected lease', () => {
    const request = subscriptionMutationRequestSchema.parse({
      schemaVersion: '1',
      account: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        expectedStateVersion: 1,
      },
      resourceScopeHash: hash,
      expectedLeaseEpoch: 1,
      mutationClaim: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        resourceScopeHash: hash,
        leaseEpoch: 1,
        mutationEpoch: 1,
        requestFingerprint: hash,
        owner: 'worker-a',
        expiresAt: '2026-07-17T13:00:00.000Z',
        mutation: 'renew',
      },
      expectedClaimRequestFingerprint: hash,
      expectedMutation: 'renew',
      providerIdempotencyKey: 'renew-a',
      requestedExpiresAt: '2026-07-17T14:00:00.000Z',
    });

    expect(() =>
      assertSubscriptionMutationFence(
        { ...request, expectedLeaseEpoch: 2 },
        '2026-07-17T12:00:00.000Z',
      ),
    ).toThrow('SUBSCRIPTION_MUTATION_FENCE_REJECTED');
  });

  it('never invokes a subscription adapter with a stale claim', async () => {
    let calls = 0;
    const methods: string[] = [];
    const descriptor = connectorDescriptorSchema.parse({
      schemaVersion: '1',
      connectorId: 'subscription-test',
      descriptorVersion: '1',
      provider: 'test',
      channel: 'email',
      connectionStrategy: 'none',
      authorizationScopes: [],
      capabilities: {
        read: false,
        send: false,
        webhook: true,
        poll: false,
        threads: false,
        attachments: false,
        deliveryFeedback: false,
        multipleAccounts: false,
        historicalBackfill: false,
        externalEffect: false,
        replyCorrelation: false,
        complaintFeedback: false,
        unsubscribeFeedback: false,
        optOutFeedback: false,
        reconsentFeedback: false,
        consentWindowEligibility: false,
      },
      supportedRuntimeModes: ['virtual_test'],
      constraints: [],
    });
    const connector = {
      descriptor: () => descriptor,
      subscribe: () => {
        calls += 1;
        methods.push('subscribe');
        return Promise.resolve({
          providerReference: 'subscription-a',
          providerResponseHash: hash,
          expiresAt: '2026-07-17T14:00:00.000Z',
          renewAfter: '2026-07-17T13:00:00.000Z',
          observedAt: '2026-07-17T12:00:00.000Z',
        });
      },
      renewSubscription: () => {
        calls += 1;
        methods.push('renew');
        return Promise.resolve({
          providerReference: 'subscription-a',
          providerResponseHash: hash,
          expiresAt: '2026-07-17T14:00:00.000Z',
          renewAfter: '2026-07-17T13:00:00.000Z',
          observedAt: '2026-07-17T12:00:00.000Z',
        });
      },
    } as unknown as CommunicationConnector;
    const request = subscriptionMutationRequestSchema.parse({
      schemaVersion: '1',
      account: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        expectedStateVersion: 1,
      },
      resourceScopeHash: hash,
      expectedLeaseEpoch: 1,
      mutationClaim: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        resourceScopeHash: hash,
        leaseEpoch: 1,
        mutationEpoch: 1,
        requestFingerprint: hash,
        owner: 'worker-a',
        expiresAt: '2026-07-17T13:00:00.000Z',
        mutation: 'create',
      },
      expectedClaimRequestFingerprint: hash,
      expectedMutation: 'create',
      providerIdempotencyKey: 'create-a',
      requestedExpiresAt: '2026-07-17T14:00:00.000Z',
    });

    await expect(
      invokeCommunicationSubscriptionMutation(
        connector,
        request,
        '2026-07-17T13:00:00.000Z',
      ),
    ).rejects.toThrow('SUBSCRIPTION_MUTATION_FENCE_REJECTED');
    expect(calls).toBe(0);
    await expect(
      invokeCommunicationSubscriptionMutation(
        connector,
        request,
        '2026-07-17T12:00:00.000Z',
      ),
    ).resolves.toMatchObject({ providerReference: 'subscription-a' });
    expect(calls).toBe(1);
    expect(methods).toEqual(['subscribe']);

    const renewal = subscriptionMutationRequestSchema.parse({
      ...request,
      mutationClaim: {
        ...request.mutationClaim,
        mutationEpoch: 2,
        mutation: 'renew',
      },
      expectedMutation: 'renew',
      providerIdempotencyKey: 'renew-a',
    });
    await invokeCommunicationSubscriptionMutation(
      connector,
      renewal,
      '2026-07-17T12:00:00.000Z',
    );
    expect(methods).toEqual(['subscribe', 'renew']);
  });
});

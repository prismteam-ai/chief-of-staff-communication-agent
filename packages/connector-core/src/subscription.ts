import {
  providerSubscriptionResultSchema,
  subscriptionMutationRequestSchema,
} from '@chief/contracts/connectors';
import type {
  ProviderSubscriptionResult,
  SubscriptionMutationRequest,
} from '@chief/contracts/connectors';

import type { CommunicationConnector } from './communication-connector.js';
import type { WorkManagementConnector } from './work-management-connector.js';

export type { ProviderSubscriptionResult, SubscriptionMutationRequest };

export function assertSubscriptionMutationFence(
  request: SubscriptionMutationRequest,
  observedAt: string,
): void {
  const claimExpiry = Date.parse(request.mutationClaim.expiresAt);
  const observedInstant = Date.parse(observedAt);
  if (
    request.mutationClaim.tenantId !== request.account.tenantId ||
    request.mutationClaim.accountId !== request.account.accountId ||
    request.mutationClaim.resourceScopeHash !== request.resourceScopeHash ||
    request.mutationClaim.leaseEpoch !== request.expectedLeaseEpoch ||
    request.mutationClaim.requestFingerprint !==
      request.expectedClaimRequestFingerprint ||
    request.mutationClaim.mutation !== request.expectedMutation ||
    request.mutationClaim.mutationEpoch <= 0 ||
    request.mutationClaim.owner.length === 0 ||
    request.mutationClaim.requestFingerprint.length === 0 ||
    !Number.isFinite(claimExpiry) ||
    !Number.isFinite(observedInstant) ||
    claimExpiry <= observedInstant
  ) {
    throw new Error('SUBSCRIPTION_MUTATION_FENCE_REJECTED');
  }
}

export async function invokeCommunicationSubscriptionMutation(
  connector: CommunicationConnector,
  requestInput: SubscriptionMutationRequest,
  observedAt: string,
): Promise<ProviderSubscriptionResult> {
  const request = subscriptionMutationRequestSchema.parse(requestInput);
  if (!connector.descriptor().capabilities.webhook) {
    throw new Error('SUBSCRIPTION_CAPABILITY_NOT_AVAILABLE');
  }
  if (request.expectedMutation === 'teardown') {
    throw new Error('SUBSCRIPTION_TEARDOWN_NOT_SUPPORTED');
  }
  if (request.expectedMutation === 'renew') {
    if (connector.renewSubscription === undefined) {
      throw new Error('SUBSCRIPTION_METHOD_NOT_AVAILABLE');
    }
    assertSubscriptionMutationFence(request, observedAt);
    return providerSubscriptionResultSchema.parse(
      await connector.renewSubscription(request.account, request),
    );
  }
  if (connector.subscribe === undefined) {
    throw new Error('SUBSCRIPTION_METHOD_NOT_AVAILABLE');
  }
  assertSubscriptionMutationFence(request, observedAt);
  return providerSubscriptionResultSchema.parse(
    await connector.subscribe(request.account, request),
  );
}

export async function invokeWorkManagementSubscriptionMutation(
  connector: WorkManagementConnector,
  requestInput: SubscriptionMutationRequest,
  observedAt: string,
): Promise<ProviderSubscriptionResult> {
  const request = subscriptionMutationRequestSchema.parse(requestInput);
  if (!connector.descriptor().capabilities.webhooks) {
    throw new Error('SUBSCRIPTION_CAPABILITY_NOT_AVAILABLE');
  }
  if (request.expectedMutation === 'teardown') {
    throw new Error('SUBSCRIPTION_TEARDOWN_NOT_SUPPORTED');
  }
  if (request.expectedMutation === 'renew') {
    if (connector.renewSubscription === undefined) {
      throw new Error('SUBSCRIPTION_METHOD_NOT_AVAILABLE');
    }
    assertSubscriptionMutationFence(request, observedAt);
    return providerSubscriptionResultSchema.parse(
      await connector.renewSubscription(request.account, request),
    );
  }
  if (connector.subscribe === undefined) {
    throw new Error('SUBSCRIPTION_METHOD_NOT_AVAILABLE');
  }
  assertSubscriptionMutationFence(request, observedAt);
  return providerSubscriptionResultSchema.parse(
    await connector.subscribe(request.account, request),
  );
}

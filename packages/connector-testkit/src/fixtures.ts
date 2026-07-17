import {
  effectExecutionArtifactSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import type {
  EffectExecutionArtifact,
  FeedbackContext,
  ReconcileSendRequest,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorAccountSchema,
  connectorDescriptorSchema,
  connectorSnapshotSchema,
  pollRequestSchema,
  rawWebhookRequestSchema,
  subscriptionMutationRequestSchema,
  verifiedProviderEventSchema,
} from '@chief/contracts/connectors';
import { keyedDigestValueSchema } from '@chief/contracts/ids';
import type {
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorDescriptor,
  ConnectorSnapshot,
  PollRequest,
  RawWebhookRequest,
  SubscriptionMutationRequest,
  VerifiedProviderEvent,
} from '@chief/contracts/connectors';

export const FIXTURE_NOW = '2026-07-17T12:00:00.000Z';
export const FIXTURE_LATER = '2026-07-17T13:00:00.000Z';
export const FIXTURE_HASH = 'a'.repeat(64);
export const FIXTURE_HASH_B = 'b'.repeat(64);
export const FIXTURE_HASH_C = 'c'.repeat(64);
export const FIXTURE_KEYED_DIGEST = keyedDigestValueSchema.parse(
  'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
);

export interface ConnectorContractFixtures {
  readonly descriptor: ConnectorDescriptor;
  readonly snapshot: ConnectorSnapshot;
  readonly account: ConnectorAccount;
  readonly accountRef: ConnectorAccountRef;
  readonly artifact: EffectExecutionArtifact;
  readonly reconcileRequest: ReconcileSendRequest;
  readonly verifiedEvent: VerifiedProviderEvent;
  readonly webhookRequest: RawWebhookRequest;
  readonly pollRequest: PollRequest;
  readonly subscriptionRequest: SubscriptionMutationRequest;
  readonly feedbackContext: FeedbackContext;
}

export function createConnectorContractFixtures(): ConnectorContractFixtures {
  const descriptor = connectorDescriptorSchema.parse({
    schemaVersion: '1',
    connectorId: 'test-communication',
    descriptorVersion: '1.0.0',
    provider: 'deterministic-test-provider',
    channel: 'email',
    connectionStrategy: 'none',
    authorizationScopes: [],
    capabilities: {
      read: true,
      send: true,
      webhook: true,
      poll: true,
      threads: true,
      attachments: true,
      deliveryFeedback: true,
      multipleAccounts: true,
      historicalBackfill: true,
      externalEffect: true,
      replyCorrelation: true,
      complaintFeedback: true,
      unsubscribeFeedback: true,
      optOutFeedback: true,
      reconsentFeedback: true,
      consentWindowEligibility: true,
    },
    supportedRuntimeModes: ['live', 'fixture'],
    constraints: ['contract-test-only'],
  });
  const snapshot = connectorSnapshotSchema.parse({
    connectorId: descriptor.connectorId,
    descriptorVersion: descriptor.descriptorVersion,
    accountId: 'account-a',
    capabilitySnapshotHash: FIXTURE_HASH,
    runtimeMode: 'live',
    selectionState: 'selected',
  });
  const accountRef = connectorAccountRefSchema.parse({
    tenantId: 'tenant-a',
    accountId: snapshot.accountId,
    expectedStateVersion: 1,
  });
  const account = connectorAccountSchema.parse({
    tenantId: accountRef.tenantId,
    accountId: accountRef.accountId,
    ownerUserId: 'user-a',
    provider: descriptor.provider,
    channel: descriptor.channel,
    providerAccountDigest: FIXTURE_KEYED_DIGEST,
    displayLabel: 'Deterministic provider',
    snapshot,
    status: 'active',
    health: 'healthy',
    stateVersion: accountRef.expectedStateVersion,
    updatedAt: FIXTURE_NOW,
  });
  const artifact = effectExecutionArtifactSchema.parse({
    schemaVersion: '1',
    tenantId: accountRef.tenantId,
    operationId: 'operation-a',
    attemptId: 'attempt-a',
    stableIdempotencyKey: 'stable-operation-a',
    account: accountRef,
    sourceMessageRevisionId: 'message-revision-a',
    actionPlanId: 'action-plan-a',
    actionPlanHash: FIXTURE_HASH,
    approvalId: 'approval-a',
    draftRevisionId: 'draft-revision-a',
    renderedPayloadFingerprint: FIXTURE_HASH_B,
    connectorSnapshot: snapshot,
    clientCorrelation: {
      kind: 'rfc_message_id',
      value: '<operation-a@example.invalid>',
    },
    correlationBindingVersion: '1',
    reconciliationStrategy: 'test-lookup',
    reconciliationStrategyVersion: '1',
    createdAt: FIXTURE_NOW,
  });
  const reconcileRequest = reconcileSendRequestSchema.parse({
    schemaVersion: '1',
    artifact,
    priorAttemptId: artifact.attemptId,
    strategy: artifact.reconciliationStrategy,
    strategyVersion: artifact.reconciliationStrategyVersion,
    maxProviderQueries: 2,
  });
  const verifiedEvent = verifiedProviderEventSchema.parse({
    schemaVersion: '1',
    tenantId: accountRef.tenantId,
    accountId: accountRef.accountId,
    providerEventId: 'provider-event-a',
    rawEventRef: 's3://private-fixture/raw-event-a',
    rawPayloadDigest: FIXTURE_HASH_C,
    verifiedAt: FIXTURE_NOW,
    verificationMethod: 'deterministic-signature-v1',
    connectorSnapshot: snapshot,
  });
  const webhookRequest = rawWebhookRequestSchema.parse({
    method: 'POST',
    providerVisibleUrl: 'https://example.invalid/webhooks/test',
    headers: { 'x-test-signature': 'valid' },
    rawBodyBase64: 'e30=',
    receivedAt: FIXTURE_NOW,
  });
  const pollRequest = pollRequestSchema.parse({
    schemaVersion: '1',
    account: accountRef,
    resourceScopeHash: FIXTURE_HASH,
    checkpoint: {
      schemaVersion: '1',
      tenantId: accountRef.tenantId,
      accountId: accountRef.accountId,
      resourceScopeHash: FIXTURE_HASH,
      kind: 'cursor',
      encryptedCursor: 'encrypted:test-cursor',
      checkpointEpoch: 1,
      adapterVersion: descriptor.descriptorVersion,
      sourceWatermark: 'watermark-0',
      lastCompletePage: 0,
      status: 'active',
      committedAt: FIXTURE_NOW,
    },
    expectedCheckpointEpoch: 1,
    adapterVersion: descriptor.descriptorVersion,
    maxItems: 100,
    maxPages: 2,
  });
  const subscriptionRequest = subscriptionMutationRequestSchema.parse({
    schemaVersion: '1',
    account: accountRef,
    resourceScopeHash: FIXTURE_HASH,
    expectedLeaseEpoch: 1,
    mutationClaim: {
      tenantId: accountRef.tenantId,
      accountId: accountRef.accountId,
      resourceScopeHash: FIXTURE_HASH,
      leaseEpoch: 1,
      mutationEpoch: 1,
      requestFingerprint: FIXTURE_HASH_B,
      owner: 'contract-runner',
      expiresAt: FIXTURE_LATER,
      mutation: 'create',
    },
    expectedClaimRequestFingerprint: FIXTURE_HASH_B,
    expectedMutation: 'create',
    providerIdempotencyKey: 'subscription-create-a',
    requestedExpiresAt: '2026-07-17T14:00:00.000Z',
  });
  const feedbackContext: FeedbackContext = {
    tenantId: accountRef.tenantId,
    account: accountRef,
    connectorSnapshot: snapshot,
    knownOperationId: artifact.operationId,
    knownAttemptId: artifact.attemptId,
  };

  return {
    descriptor,
    snapshot,
    account,
    accountRef,
    artifact,
    reconcileRequest,
    verifiedEvent,
    webhookRequest,
    pollRequest,
    subscriptionRequest,
    feedbackContext,
  };
}

import { describe, expect, it } from 'vitest';

import {
  actionPlanSchema,
  connectorAccountSchema,
  effectExecutionArtifactSchema,
  eventOutboxRecordSchema,
  feedbackContextSchema,
  pollRequestSchema,
  subscriptionMutationRequestSchema,
  verifiedProviderEventSchema,
} from './index.js';

const sha = 'a'.repeat(64);
const keyedDigest = `h1_v1_${'A'.repeat(43)}`;
const now = '2026-07-17T12:00:00.000Z';

function snapshot(accountId = 'account-a') {
  return {
    connectorId: 'gmail',
    descriptorVersion: '1',
    accountId,
    capabilitySnapshotHash: sha,
    runtimeMode: 'fixture',
    selectionState: 'selected',
  } as const;
}

const accountRef = {
  tenantId: 'tenant-a',
  accountId: 'account-a',
  expectedStateVersion: 1,
};

describe('canonical aggregate scope bindings', () => {
  it('binds connector account identity to its snapshot', () => {
    const account = {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      ownerUserId: 'user-a',
      brandId: 'brand-a',
      provider: 'google',
      channel: 'email',
      providerAccountDigest: keyedDigest,
      displayLabel: 'Work Gmail',
      snapshot: snapshot(),
      status: 'active',
      health: 'healthy',
      stateVersion: 1,
      updatedAt: now,
    };
    expect(connectorAccountSchema.safeParse(account).success).toBe(true);
    expect(
      connectorAccountSchema.safeParse({
        ...account,
        snapshot: snapshot('account-b'),
      }).success,
    ).toBe(false);
  });

  it('binds subscription requests and poll requests to their claims/checkpoints', () => {
    const claim = {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      resourceScopeHash: sha,
      leaseEpoch: 1,
      mutationEpoch: 1,
      requestFingerprint: sha,
      owner: 'worker-a',
      expiresAt: '2026-07-17T13:00:00.000Z',
      mutation: 'renew',
    };
    const subscription = {
      schemaVersion: '1',
      account: accountRef,
      resourceScopeHash: sha,
      expectedLeaseEpoch: 1,
      mutationClaim: claim,
      expectedClaimRequestFingerprint: sha,
      expectedMutation: 'renew',
      providerIdempotencyKey: 'renew-a',
      requestedExpiresAt: '2026-07-18T12:00:00.000Z',
    };
    expect(
      subscriptionMutationRequestSchema.safeParse(subscription).success,
    ).toBe(true);
    expect(
      subscriptionMutationRequestSchema.safeParse({
        ...subscription,
        mutationClaim: { ...claim, tenantId: 'tenant-b' },
      }).success,
    ).toBe(false);

    const checkpoint = {
      schemaVersion: '1',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      resourceScopeHash: sha,
      kind: 'history',
      encryptedCursor: 'cipher:cursor',
      checkpointEpoch: 1,
      adapterVersion: '1',
      sourceWatermark: '100',
      lastCompletePage: 0,
      status: 'active',
      committedAt: now,
    };
    const poll = {
      schemaVersion: '1',
      account: accountRef,
      resourceScopeHash: sha,
      checkpoint,
      expectedCheckpointEpoch: 1,
      adapterVersion: '1',
      maxItems: 100,
      maxPages: 2,
    };
    expect(pollRequestSchema.safeParse(poll).success).toBe(true);
    expect(
      pollRequestSchema.safeParse({
        ...poll,
        adapterVersion: '2',
      }).success,
    ).toBe(false);
  });

  it('binds inbound, feedback, and execution artifacts to one account scope', () => {
    const verifiedEvent = {
      schemaVersion: '1',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      providerEventId: 'event-a',
      rawEventRef: 'raw:event-a',
      rawPayloadDigest: sha,
      verifiedAt: now,
      verificationMethod: 'signature',
      connectorSnapshot: snapshot(),
    };
    expect(verifiedProviderEventSchema.safeParse(verifiedEvent).success).toBe(
      true,
    );
    expect(
      verifiedProviderEventSchema.safeParse({
        ...verifiedEvent,
        connectorSnapshot: snapshot('account-b'),
      }).success,
    ).toBe(false);

    const feedback = {
      tenantId: 'tenant-a',
      account: accountRef,
      connectorSnapshot: snapshot(),
    };
    expect(feedbackContextSchema.safeParse(feedback).success).toBe(true);
    expect(
      feedbackContextSchema.safeParse({
        ...feedback,
        tenantId: 'tenant-b',
      }).success,
    ).toBe(false);

    const artifact = {
      schemaVersion: '1',
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      attemptId: 'attempt-a',
      stableIdempotencyKey: 'operation-a',
      account: accountRef,
      sourceMessageRevisionId: 'message-revision-a',
      actionPlanId: 'action-plan-a',
      actionPlanHash: sha,
      approvalId: 'approval-a',
      renderedPayloadFingerprint: sha,
      connectorSnapshot: snapshot(),
      clientCorrelation: { kind: 'client_reference', value: 'operation-a' },
      correlationBindingVersion: '1',
      reconciliationStrategy: 'query-by-client-reference',
      reconciliationStrategyVersion: '1',
      createdAt: now,
    };
    expect(effectExecutionArtifactSchema.safeParse(artifact).success).toBe(
      true,
    );
    expect(
      effectExecutionArtifactSchema.safeParse({
        ...artifact,
        tenantId: 'tenant-b',
      }).success,
    ).toBe(false);
  });

  it('binds nested events and requires unique planned operation IDs', () => {
    const event = {
      schemaVersion: '1',
      eventId: 'event-a',
      tenantId: 'tenant-a',
      eventType: 'message.received',
      aggregateType: 'message',
      aggregateId: 'message-a',
      aggregateVersion: 1,
      payloadHash: sha,
      payloadRef: 'blob:event-a',
      occurredAt: now,
      correlationId: 'correlation-a',
    };
    const outbox = {
      schemaVersion: '1',
      outboxItemId: 'outbox-a',
      tenantId: 'tenant-a',
      event,
      busName: 'chief-product',
      eventContractVersion: '1',
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
    };
    expect(eventOutboxRecordSchema.safeParse(outbox).success).toBe(true);
    expect(
      eventOutboxRecordSchema.safeParse({
        ...outbox,
        tenantId: 'tenant-b',
      }).success,
    ).toBe(false);

    const operation = {
      kind: 'send_message',
      operationId: 'operation-a',
      connectorAccountId: 'account-a',
      draftRevisionId: 'draft-revision-a',
      recipientDigests: [keyedDigest],
      renderedPayloadFingerprint: sha,
    };
    const plan = {
      schemaVersion: '1',
      tenantId: 'tenant-a',
      actionPlanId: 'action-plan-a',
      revision: 1,
      sourceMessageRevisionId: 'message-revision-a',
      operations: [operation],
      policyVersion: '1',
      expiresAt: '2026-07-17T13:00:00.000Z',
      canonicalHash: sha,
      createdAt: now,
    };
    expect(actionPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      actionPlanSchema.safeParse({
        ...plan,
        operations: [operation, operation],
      }).success,
    ).toBe(false);
  });
});

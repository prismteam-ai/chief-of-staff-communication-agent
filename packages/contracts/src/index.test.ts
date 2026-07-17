import { describe, expect, it } from 'vitest';

import {
  contactChannelPolicySchema,
  connectorDescriptorSchema,
  createHealthResponse,
  effectExecutionArtifactSchema,
  foundationCapabilities,
  healthResponseSchema,
  keyedDigestValueSchema,
  listCommunicationsInputSchema,
  mcpSearchKnowledgeInputSchema,
  mcpSubmitForApprovalResultSchema,
  sendAttemptSchema,
  sensitiveIdentifierDigestSchema,
  sha256Schema,
  subscriptionMutationRequestSchema,
  transportStateSchema,
  verifiedActorContextSchema,
  workManagementDescriptorSchema,
} from './index.js';

const digest = 'a'.repeat(64);
const keyedDigest = `h1_v1_${'A'.repeat(43)}`;

describe('foundation contracts', () => {
  it('creates a valid truthful health response', () => {
    const response = createHealthResponse('chief-api');

    expect(healthResponseSchema.parse(response)).toEqual(response);
    expect(response.foundationOnly).toBe(true);
  });

  it('keeps future capabilities explicitly named', () => {
    expect(foundationCapabilities).toEqual([
      'connectors',
      'oauth',
      'rag',
      'actions',
      'agents',
    ]);
  });

  it('rejects persisted display-only transport state', () => {
    expect(transportStateSchema.safeParse('sent').success).toBe(false);
  });

  it('distinguishes exact keyed identity digests from content hashes', () => {
    expect(keyedDigestValueSchema.safeParse(keyedDigest).success).toBe(true);
    expect(keyedDigestValueSchema.safeParse(digest).success).toBe(false);
    expect(sha256Schema.safeParse(digest).success).toBe(true);
    expect(sha256Schema.safeParse(keyedDigest).success).toBe(false);
    for (const malformed of [
      `h2_v1_${'A'.repeat(43)}`,
      `h1_${'v'.repeat(33)}_${'A'.repeat(43)}`,
      `h1_v1_${'A'.repeat(42)}`,
      `h1_v1_${'A'.repeat(44)}`,
      `h1_v1_${'A'.repeat(42)}a`,
    ]) {
      expect(keyedDigestValueSchema.safeParse(malformed).success).toBe(false);
    }
    const sensitive = {
      schemaVersion: '1',
      tenantId: 'tenant-a',
      purpose: 'identity',
      normalizationVersion: '1',
      keyVersion: 'v1',
      digest: keyedDigest,
    };
    expect(sensitiveIdentifierDigestSchema.safeParse(sensitive).success).toBe(
      true,
    );
    expect(
      sensitiveIdentifierDigestSchema.safeParse({
        ...sensitive,
        digest,
      }).success,
    ).toBe(false);
    expect(
      sensitiveIdentifierDigestSchema.safeParse({
        ...sensitive,
        keyVersion: 'v2',
      }).success,
    ).toBe(false);
  });

  it('rejects caller-shaped authority and unknown fields', () => {
    expect(
      verifiedActorContextSchema.safeParse({
        authoritySource: 'caller_header',
        tenantId: 'tenant-a',
      }).success,
    ).toBe(false);
    expect(
      listCommunicationsInputSchema.safeParse({
        limit: 10,
        actor: { tenantId: 'tenant-a' },
      }).success,
    ).toBe(false);
    expect(
      listCommunicationsInputSchema.safeParse({
        limit: 10,
        accountId: 'account-a',
      }).success,
    ).toBe(false);
    expect(
      mcpSearchKnowledgeInputSchema.safeParse({
        queryText: 'delivery date',
        exactEntityRefs: [],
        limit: 10,
        scope: { tenantId: 'tenant-a' },
      }).success,
    ).toBe(false);
  });

  it('returns only a proposal handoff from submit_for_approval', () => {
    const handoff = {
      proposalId: 'proposal-a',
      approvalUrl: 'https://chief.example/approvals/proposal-a',
      status: 'pending_approval',
      directEffectAvailable: false,
    };
    expect(mcpSubmitForApprovalResultSchema.parse(handoff)).toEqual(handoff);
    expect(
      mcpSubmitForApprovalResultSchema.safeParse({ approval: {} }).success,
    ).toBe(false);
    expect(
      mcpSubmitForApprovalResultSchema.safeParse({
        ...handoff,
        approvalUrl: 'http://chief.example/approvals/proposal-a',
      }).success,
    ).toBe(false);
  });

  it('keeps effects and policy contracts strict', () => {
    expect(effectExecutionArtifactSchema.safeParse({}).success).toBe(false);
    expect(
      contactChannelPolicySchema.safeParse({ unexpected: true }).success,
    ).toBe(false);
  });

  it('enforces connection-strategy-specific descriptor fields', () => {
    const capabilities = {
      read: true,
      send: false,
      webhook: false,
      poll: true,
      threads: true,
      attachments: true,
      deliveryFeedback: false,
      multipleAccounts: true,
      historicalBackfill: true,
      externalEffect: false,
      replyCorrelation: true,
      complaintFeedback: false,
      unsubscribeFeedback: false,
      optOutFeedback: false,
      reconsentFeedback: false,
      consentWindowEligibility: false,
    };
    const descriptor = {
      schemaVersion: '1',
      connectorId: 'gmail',
      descriptorVersion: '1',
      provider: 'google',
      channel: 'email',
      connectionStrategy: 'oauth',
      authorizationAudience: 'google',
      authorizationScopes: ['mail.read'],
      capabilities,
      supportedRuntimeModes: ['fixture'],
      constraints: [],
    };

    expect(connectorDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(
      connectorDescriptorSchema.safeParse({
        ...descriptor,
        authorizationAudience: undefined,
      }).success,
    ).toBe(false);
    expect(
      connectorDescriptorSchema.safeParse({
        ...descriptor,
        connectionStrategy: 'none',
      }).success,
    ).toBe(false);
  });

  it('keeps work-management capabilities distinct from communications', () => {
    const descriptor = workManagementDescriptorSchema.parse({
      schemaVersion: '1',
      connectorId: 'asana',
      descriptorVersion: '1',
      provider: 'asana',
      connectionStrategy: 'oauth',
      authorizationAudience: 'asana',
      authorizationScopes: ['tasks:read', 'tasks:write'],
      capabilities: {
        readTasks: true,
        readProjects: true,
        readMilestones: true,
        readComments: true,
        createTask: true,
        updateTask: true,
        createComment: true,
        webhooks: true,
        attachments: false,
        multipleAccounts: true,
        externalEffect: false,
      },
      supportedRuntimeModes: ['fixture'],
      constraints: [],
    });
    expect('send' in descriptor.capabilities).toBe(false);
    expect('threads' in descriptor.capabilities).toBe(false);
  });

  it('binds subscription claims and unknown-acceptance persistence', () => {
    const claim = {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      resourceScopeHash: digest,
      leaseEpoch: 1,
      mutationEpoch: 1,
      requestFingerprint: digest,
      owner: 'worker-a',
      expiresAt: '2026-07-17T13:00:00.000Z',
      mutation: 'renew',
    };
    const request = {
      schemaVersion: '1',
      account: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        expectedStateVersion: 1,
      },
      resourceScopeHash: digest,
      expectedLeaseEpoch: 1,
      mutationClaim: claim,
      expectedClaimRequestFingerprint: digest,
      expectedMutation: 'renew',
      providerIdempotencyKey: 'renew-a',
      requestedExpiresAt: '2026-07-18T12:00:00.000Z',
    };
    expect(subscriptionMutationRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      subscriptionMutationRequestSchema.safeParse({
        ...request,
        expectedClaimRequestFingerprint: 'b'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      subscriptionMutationRequestSchema.safeParse({
        ...request,
        expectedMutation: 'delete',
      }).success,
    ).toBe(false);

    const unknownAttempt = {
      schemaVersion: '1',
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      attemptId: 'attempt-a',
      artifactHash: digest,
      stableIdempotencyKey: 'operation-a',
      lifecycleState: 'reconciliation_required',
      transportState: 'acceptance_unknown',
      clientCorrelation: { kind: 'client_reference', value: 'operation-a' },
      correlationBindingVersion: '1',
      retryDecision: 'retry_denied',
      attemptedAt: '2026-07-17T12:00:00.000Z',
      stateVersion: 1,
    };
    expect(sendAttemptSchema.safeParse(unknownAttempt).success).toBe(true);
    expect(
      sendAttemptSchema.safeParse({
        ...unknownAttempt,
        retryDecision: 'retry_allowed',
      }).success,
    ).toBe(false);
    expect(
      sendAttemptSchema.safeParse({
        ...unknownAttempt,
        lifecycleState: 'dispatching',
      }).success,
    ).toBe(false);
    const acceptedAttempt = {
      ...unknownAttempt,
      lifecycleState: 'settled',
      transportState: 'provider_accepted',
      providerCorrelationDigest: keyedDigest,
    };
    expect(sendAttemptSchema.safeParse(acceptedAttempt).success).toBe(true);
    expect(
      sendAttemptSchema.safeParse({
        ...acceptedAttempt,
        providerCorrelationDigest: digest,
      }).success,
    ).toBe(false);
    expect(
      sendAttemptSchema.safeParse({
        ...acceptedAttempt,
        providerCorrelationDigest: undefined,
        providerCorrelation: 'raw-provider-id',
      }).success,
    ).toBe(false);
  });
});

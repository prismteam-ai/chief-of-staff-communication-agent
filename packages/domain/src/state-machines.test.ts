import {
  actionPlanSchema,
  actionRecommendationSchema,
  approvalSchema,
  contactChannelPolicySchema,
  connectorAccountSchema,
  draftHeadSchema,
  draftRevisionSchema,
  effectExecutionArtifactSchema,
  keyedDigestValueSchema,
  leaseMutationClaimSchema,
  messageRevisionSchema,
  oauthCredentialStateSchema,
  recommendationHeadSchema,
  refreshClaimSchema,
  riskAcknowledgementSchema,
  sendAttemptSchema,
  subscriptionLeaseSchema,
  suppressionFactSchema,
  syncCheckpointSchema,
  tenantIdSchema,
} from '@chief/contracts';
import { describe, expect, it } from 'vitest';

import {
  advanceSyncCheckpoint,
  appendMessageRevision,
  applyTransportFact,
  assertApprovalAuthorizes,
  assertEffectNotDuplicated,
  assertOrdinaryRetryAllowed,
  assertRiskAcknowledgedResend,
  DomainInvariantError,
  reconcileAcceptanceUnknown,
  reduceContactPolicy,
  rotateOAuthCredential,
  swapDraftHead,
  swapRecommendationHead,
  transitionApproval,
  transitionConnectorAccount,
  transitionSubscriptionLease,
} from './index.js';

const digest = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const keyedDigest = keyedDigestValueSchema.parse(`h1_v1_${'A'.repeat(43)}`);
const keyedDigestB = keyedDigestValueSchema.parse(`h1_v1_${'B'.repeat(42)}A`);
const now = '2026-07-17T12:00:00.000Z';
const later = '2026-07-17T13:00:00.000Z';
const tenantA = tenantIdSchema.parse('tenant-a');
const tenantB = tenantIdSchema.parse('tenant-b');

const snapshot = {
  connectorId: 'gmail',
  descriptorVersion: '1',
  accountId: 'account-a',
  capabilitySnapshotHash: digest,
  runtimeMode: 'fixture',
  selectionState: 'selected',
} as const;

const account = connectorAccountSchema.parse({
  tenantId: tenantA,
  accountId: 'account-a',
  ownerUserId: 'user-a',
  provider: 'gmail',
  channel: 'email',
  providerAccountDigest: keyedDigest,
  displayLabel: 'Executive Gmail',
  snapshot,
  status: 'pending',
  health: 'unknown',
  stateVersion: 1,
  updatedAt: now,
});

const lease = subscriptionLeaseSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  accountId: 'account-a',
  resourceScopeHash: digest,
  kind: 'subscription',
  leaseEpoch: 1,
  optimisticVersion: 1,
  expiresAt: later,
  renewAfter: now,
  status: 'candidate',
});

const leaseClaim = leaseMutationClaimSchema.parse({
  tenantId: tenantA,
  accountId: 'account-a',
  resourceScopeHash: digest,
  leaseEpoch: 1,
  mutationEpoch: 7,
  requestFingerprint: digest,
  owner: 'worker-a',
  expiresAt: later,
  mutation: 'create',
});

const checkpoint = syncCheckpointSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  accountId: 'account-a',
  resourceScopeHash: digest,
  kind: 'history',
  encryptedCursor: 'ciphertext:one',
  checkpointEpoch: 1,
  adapterVersion: '1',
  sourceWatermark: '100',
  lastCompletePage: 0,
  status: 'active',
  committedAt: now,
});

const blob = {
  schemaVersion: '1',
  tenantId: tenantA,
  bucketRef: 'messages',
  objectKey: 'tenant-a/message',
  objectVersion: 'v1',
  contentHash: digest,
  byteLength: 5,
  mediaType: 'text/plain',
  encryptionKeyRef: 'kms:key',
  retentionPolicyVersion: '1',
} as const;

const message = messageRevisionSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  messageId: 'message-a',
  revisionId: 'message-revision-1',
  revision: 1,
  threadId: 'thread-a',
  connectorSnapshot: snapshot,
  providerMessageIdDigest: keyedDigest,
  direction: 'inbound',
  sender: {
    identityDigest: keyedDigest,
    encryptedAddressRef: 'cipher:sender',
  },
  recipients: [
    {
      identityDigest: keyedDigestB,
      encryptedAddressRef: 'cipher:recipient',
    },
  ],
  immutableProviderBody: blob,
  fullNormalizedBody: blob,
  currentAuthoredSegment: {
    parserVersion: '1',
    inputBodyHash: digest,
    authoredText: 'hello',
    boundaries: [{ kind: 'authored', start: 0, end: 5 }],
    confidence: 1,
    ambiguityReasons: [],
    localeMarkers: ['en'],
    derivedAt: now,
  },
  attachmentIds: [],
  sourceTimestamp: now,
  ingestedAt: now,
  contentHash: digest,
  visibility: 'private',
});

const reproducibility = {
  schemaVersion: '1',
  selectedProfileManifestHash: digest,
  routeId: 'action',
  modelProfileId: 'fixture',
  gatewayVersion: '1',
  promptHash: digest,
  policyHash: digest,
  schemaHash: digest,
  retrievalQueryHash: digest,
  retrievalSnapshotManifestHash: digest,
  requestHash: digest,
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 1,
  outcome: 'valid',
} as const;

const recommendation = actionRecommendationSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  recommendationId: 'recommendation-2',
  revision: 2,
  sourceMessageRevisionId: 'message-revision-1',
  actionType: 'reply',
  structuredParameters: {},
  confidence: 0.9,
  urgency: 'normal',
  reasonSummary: 'A reply is required.',
  citations: [],
  missingFacts: [],
  status: 'current',
  reproducibility,
  createdAt: now,
});

const draft = draftRevisionSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  draftId: 'draft-a',
  draftRevisionId: 'draft-revision-2',
  revision: 2,
  connectorAccountId: 'account-a',
  sourceMessageRevisionId: 'message-revision-1',
  recipientDigests: [keyedDigestB],
  body: 'Reply',
  attachmentContentHashes: [],
  citations: [],
  styleProfileVersion: '1',
  rendererId: 'email',
  rendererVersion: '1',
  renderedPayloadFingerprint: digest,
  contentHash: digestB,
  createdBy: 'user',
  supersedesRevisionId: 'draft-revision-1',
  createdAt: now,
});

const actionPlan = actionPlanSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  actionPlanId: 'plan-a',
  revision: 1,
  sourceMessageRevisionId: 'message-revision-1',
  operations: [
    {
      kind: 'send_message',
      operationId: 'operation-a',
      connectorAccountId: 'account-a',
      draftRevisionId: 'draft-revision-2',
      recipientDigests: [keyedDigestB],
      renderedPayloadFingerprint: digest,
    },
  ],
  policyVersion: '1',
  expiresAt: later,
  canonicalHash: digest,
  createdAt: now,
});

const approval = approvalSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  approvalId: 'approval-a',
  actionPlanId: 'plan-a',
  actionPlanRevision: 1,
  actionPlanHash: digest,
  sourceMessageRevisionId: 'message-revision-1',
  approverUserId: 'user-a',
  approvedAt: now,
  expiresAt: later,
  policyVersion: '1',
  status: 'active',
  stateVersion: 1,
});

const artifact = effectExecutionArtifactSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  operationId: 'operation-a',
  attemptId: 'attempt-a',
  stableIdempotencyKey: 'operation-a',
  account: {
    tenantId: tenantA,
    accountId: 'account-a',
    expectedStateVersion: 1,
  },
  sourceMessageRevisionId: 'message-revision-1',
  actionPlanId: 'plan-a',
  actionPlanHash: digest,
  approvalId: 'approval-a',
  draftRevisionId: 'draft-revision-2',
  renderedPayloadFingerprint: digest,
  connectorSnapshot: snapshot,
  clientCorrelation: { kind: 'rfc_message_id', value: '<operation-a@example>' },
  correlationBindingVersion: '1',
  reconciliationStrategy: 'sent-folder',
  reconciliationStrategyVersion: '1',
  createdAt: now,
});

const attempt = sendAttemptSchema.parse({
  schemaVersion: '1',
  tenantId: tenantA,
  operationId: 'operation-a',
  attemptId: 'attempt-a',
  artifactHash: digest,
  stableIdempotencyKey: 'operation-a',
  lifecycleState: 'dispatching',
  transportState: 'queued',
  clientCorrelation: { kind: 'rfc_message_id', value: '<operation-a@example>' },
  correlationBindingVersion: '1',
  retryDecision: 'not_applicable',
  attemptedAt: now,
  stateVersion: 1,
});

describe('connector state machines', () => {
  it('advances account, fenced lease, and commit-coupled checkpoint immutably', () => {
    const active = transitionConnectorAccount({
      actorTenantId: tenantA,
      account,
      expectedStateVersion: 1,
      nextStatus: 'active',
      updatedAt: later,
    });
    const activeLease = transitionSubscriptionLease({
      actorTenantId: tenantA,
      lease,
      claim: leaseClaim,
      expectedLeaseEpoch: 1,
      expectedMutationEpoch: 7,
      expectedClaimOwner: 'worker-a',
      expectedClaimRequestFingerprint: digest,
      expectedMutation: 'create',
      nextStatus: 'active',
      reconciledAt: now,
    });
    const advanced = advanceSyncCheckpoint({
      actorTenantId: tenantA,
      checkpoint,
      expectedCheckpointEpoch: 1,
      encryptedCursor: 'ciphertext:two',
      sourceWatermark: '200',
      completePage: 1,
      canonicalWritesCommitted: true,
      eventOutboxCommitted: true,
      committedAt: later,
    });
    expect([
      active.status,
      activeLease.status,
      advanced.checkpointEpoch,
    ]).toEqual(['active', 'active', 2]);
    expect(account.status).toBe('pending');
  });

  it('rejects stale epochs and cross-tenant access', () => {
    expect(() =>
      advanceSyncCheckpoint({
        actorTenantId: tenantA,
        checkpoint,
        expectedCheckpointEpoch: 2,
        encryptedCursor: 'x',
        sourceWatermark: 'x',
        completePage: 1,
        canonicalWritesCommitted: true,
        eventOutboxCommitted: true,
        committedAt: later,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }));
    expect(() =>
      transitionConnectorAccount({
        actorTenantId: tenantB,
        account,
        expectedStateVersion: 1,
        nextStatus: 'active',
        updatedAt: later,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CROSS_TENANT_ACCESS' }));
    const offsetExpiredLeaseClaim = leaseMutationClaimSchema.parse({
      ...leaseClaim,
      expiresAt: '2026-07-17T13:00:00+02:00',
    });
    expect(() =>
      transitionSubscriptionLease({
        actorTenantId: tenantA,
        lease,
        claim: offsetExpiredLeaseClaim,
        expectedLeaseEpoch: 1,
        expectedMutationEpoch: 7,
        expectedClaimOwner: 'worker-a',
        expectedClaimRequestFingerprint: digest,
        expectedMutation: 'create',
        nextStatus: 'active',
        reconciledAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }));
    expect(() =>
      transitionSubscriptionLease({
        actorTenantId: tenantA,
        lease,
        claim: leaseClaim,
        expectedLeaseEpoch: 1,
        expectedMutationEpoch: 7,
        expectedClaimOwner: 'worker-a',
        expectedClaimRequestFingerprint: digest,
        expectedMutation: 'renew',
        nextStatus: 'active',
        reconciledAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }));
    expect(() =>
      transitionSubscriptionLease({
        actorTenantId: tenantA,
        lease,
        claim: leaseClaim,
        expectedLeaseEpoch: 1,
        expectedMutationEpoch: 7,
        expectedClaimOwner: 'worker-a',
        expectedClaimRequestFingerprint: digestB,
        expectedMutation: 'create',
        nextStatus: 'active',
        reconciledAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }));
  });

  it('uses credential epoch CAS and a matching refresh claim', () => {
    const credential = oauthCredentialStateSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      accountId: 'account-a',
      providerSubjectDigest: keyedDigest,
      encryptedRefreshTokenRef: 'old',
      envelopeVersion: '1',
      credentialEpoch: 1,
      optimisticVersion: 1,
      audience: 'gmail',
      scopes: ['mail'],
      tokenVersionDigest: digest,
      status: 'rotating',
      updatedAt: now,
    });
    const claim = refreshClaimSchema.parse({
      tenantId: tenantA,
      accountId: 'account-a',
      credentialEpoch: 1,
      claimEpoch: 1,
      requestFingerprint: digest,
      owner: 'worker-a',
      expiresAt: later,
      recoveryProfileVersion: '1',
    });
    const rotated = rotateOAuthCredential({
      actorTenantId: tenantA,
      credential,
      claim,
      expectedCredentialEpoch: 1,
      expectedOptimisticVersion: 1,
      expectedClaimOwner: 'worker-a',
      expectedClaimRequestFingerprint: digest,
      expectedRecoveryProfileVersion: '1',
      observedAt: now,
      encryptedRefreshTokenRef: 'new',
      tokenVersionDigest: digestB,
      updatedAt: later,
    });
    expect(rotated.credentialEpoch).toBe(2);
    expect(credential.encryptedRefreshTokenRef).toBe('old');
    expect(() =>
      rotateOAuthCredential({
        actorTenantId: tenantA,
        credential,
        claim,
        expectedCredentialEpoch: 1,
        expectedOptimisticVersion: 1,
        expectedClaimOwner: 'worker-a',
        expectedClaimRequestFingerprint: digestB,
        expectedRecoveryProfileVersion: '1',
        observedAt: now,
        encryptedRefreshTokenRef: 'new',
        tokenVersionDigest: digestB,
        updatedAt: later,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }));
    expect(() =>
      rotateOAuthCredential({
        actorTenantId: tenantA,
        credential,
        claim,
        expectedCredentialEpoch: 1,
        expectedOptimisticVersion: 1,
        expectedClaimOwner: 'worker-a',
        expectedClaimRequestFingerprint: digest,
        expectedRecoveryProfileVersion: '2',
        observedAt: now,
        encryptedRefreshTokenRef: 'new',
        tokenVersionDigest: digestB,
        updatedAt: later,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_EPOCH' }));
  });
});

describe('revision and approval reducers', () => {
  it('appends immutable message, recommendation, and draft heads', () => {
    const nextMessage = messageRevisionSchema.parse({
      ...message,
      revisionId: 'message-revision-2',
      revision: 2,
      supersedesRevisionId: 'message-revision-1',
      contentHash: digestB,
    });
    expect(
      appendMessageRevision({
        actorTenantId: tenantA,
        current: message,
        expectedRevision: 1,
        next: nextMessage,
      }).revision,
    ).toBe(2);
    const recommendationHead = recommendationHeadSchema.parse({
      tenantId: tenantA,
      sourceMessageRevisionId: 'message-revision-1',
      recommendationId: 'recommendation-1',
      revision: 1,
      headVersion: 1,
      updatedAt: now,
    });
    const draftHead = draftHeadSchema.parse({
      tenantId: tenantA,
      draftId: 'draft-a',
      draftRevisionId: 'draft-revision-1',
      revision: 1,
      headVersion: 1,
      updatedAt: now,
    });
    expect(
      swapRecommendationHead({
        actorTenantId: tenantA,
        current: recommendationHead,
        expectedHeadVersion: 1,
        next: recommendation,
        updatedAt: later,
      }).revision,
    ).toBe(2);
    expect(
      swapDraftHead({
        actorTenantId: tenantA,
        current: draftHead,
        expectedHeadVersion: 1,
        next: draft,
        updatedAt: later,
      }).revision,
    ).toBe(2);
  });

  it('rejects stale head writes and invalid approval transitions', () => {
    const head = recommendationHeadSchema.parse({
      tenantId: tenantA,
      sourceMessageRevisionId: 'message-revision-1',
      recommendationId: 'recommendation-1',
      revision: 1,
      headVersion: 2,
      updatedAt: now,
    });
    expect(() =>
      swapRecommendationHead({
        actorTenantId: tenantA,
        current: head,
        expectedHeadVersion: 1,
        next: recommendation,
        updatedAt: later,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_REVISION' }));
    const consumed = transitionApproval({
      actorTenantId: tenantA,
      approval,
      expectedStateVersion: 1,
      nextStatus: 'consumed',
    });
    expect(() =>
      transitionApproval({
        actorTenantId: tenantA,
        approval: consumed,
        expectedStateVersion: 2,
        nextStatus: 'active',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  it('authorizes only the exact immutable action plan', () => {
    expect(() =>
      assertApprovalAuthorizes({
        actorTenantId: tenantA,
        approval,
        actionPlan,
        observedAt: now,
      }),
    ).not.toThrow();
    expect(() =>
      assertApprovalAuthorizes({
        actorTenantId: tenantA,
        approval,
        actionPlan: { ...actionPlan, canonicalHash: digestB },
        observedAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'APPROVAL_INVALID' }));
    const offsetExpiredApproval = approvalSchema.parse({
      ...approval,
      expiresAt: '2026-07-17T13:00:00+02:00',
    });
    expect(() =>
      assertApprovalAuthorizes({
        actorTenantId: tenantA,
        approval: offsetExpiredApproval,
        actionPlan,
        observedAt: now,
      }),
    ).toThrowError(expect.objectContaining({ code: 'APPROVAL_INVALID' }));
  });
});

describe('contact and transport safety', () => {
  it('lets a newer restrictive contact fact win deterministically', () => {
    const allow = suppressionFactSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      factId: 'allow',
      contactIdentityDigest: keyedDigest,
      channel: 'email',
      connectorAccountId: 'account-a',
      brandId: 'brand-a',
      kind: 'controlled_recipient_allow',
      authority: 'controlled_allowlist',
      effectiveAt: now,
    });
    const complaint = suppressionFactSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      factId: 'complaint',
      contactIdentityDigest: keyedDigest,
      channel: 'email',
      connectorAccountId: 'account-a',
      brandId: 'brand-a',
      kind: 'complaint',
      authority: 'provider',
      providerEventId: 'provider-event',
      rawEventRef: 'raw:event',
      effectiveAt: later,
    });
    const policy = reduceContactPolicy({
      actorTenantId: tenantA,
      facts: [complaint, allow],
      observedAt: '2026-07-17T14:00:00.000Z',
      reducerVersion: '1',
    });
    expect(policy.state).toBe('suppressed');
    expect(policy.winningFactId).toBe('complaint');
  });

  it('requires explicit provider reconsent to supersede an opt-out', () => {
    const optOut = suppressionFactSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      factId: 'opt-out',
      contactIdentityDigest: keyedDigest,
      channel: 'sms',
      connectorAccountId: 'account-a',
      brandId: 'brand-a',
      kind: 'provider_opt_out',
      authority: 'provider',
      providerEventId: 'stop-event',
      rawEventRef: 'raw:stop',
      effectiveAt: now,
    });
    const reconsent = suppressionFactSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      factId: 'reconsent',
      contactIdentityDigest: keyedDigest,
      channel: 'sms',
      connectorAccountId: 'account-a',
      brandId: 'brand-a',
      kind: 'verified_reconsent',
      authority: 'provider',
      providerEventId: 'start-event',
      rawEventRef: 'raw:start',
      effectiveAt: later,
      supersedesFactId: 'opt-out',
    });
    expect(
      reduceContactPolicy({
        actorTenantId: tenantA,
        facts: [reconsent, optOut],
        observedAt: '2026-07-17T14:00:00.000Z',
        reducerVersion: '1',
      }).state,
    ).toBe('allowed');
  });

  it('uses instant ordering and rejects previous account/brand scope drift', () => {
    const offsetAllow = suppressionFactSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      factId: 'offset-allow',
      contactIdentityDigest: keyedDigest,
      channel: 'email',
      connectorAccountId: 'account-a',
      brandId: 'brand-a',
      kind: 'controlled_recipient_allow',
      authority: 'controlled_allowlist',
      effectiveAt: '2026-07-17T13:00:00+02:00',
    });
    const policy = reduceContactPolicy({
      actorTenantId: tenantA,
      facts: [offsetAllow],
      observedAt: now,
      reducerVersion: '1',
    });
    expect(policy.state).toBe('allowed');
    const wrongBrandPrevious = contactChannelPolicySchema.parse({
      ...policy,
      brandId: 'brand-b',
    });
    expect(() =>
      reduceContactPolicy({
        actorTenantId: tenantA,
        facts: [offsetAllow],
        observedAt: now,
        reducerVersion: '1',
        previous: wrongBrandPrevious,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CROSS_TENANT_ACCESS' }));
    const wrongAccountFact = suppressionFactSchema.parse({
      ...offsetAllow,
      factId: 'wrong-account',
      connectorAccountId: 'account-b',
    });
    expect(() =>
      reduceContactPolicy({
        actorTenantId: tenantA,
        facts: [offsetAllow, wrongAccountFact],
        observedAt: now,
        reducerVersion: '1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CROSS_TENANT_ACCESS' }));
    const wrongBrandFact = suppressionFactSchema.parse({
      ...offsetAllow,
      factId: 'wrong-brand',
      brandId: 'brand-b',
    });
    expect(() =>
      reduceContactPolicy({
        actorTenantId: tenantA,
        facts: [offsetAllow, wrongBrandFact],
        observedAt: now,
        reducerVersion: '1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CROSS_TENANT_ACCESS' }));
    const wrongTenantFact = suppressionFactSchema.parse({
      ...offsetAllow,
      factId: 'wrong-tenant',
      tenantId: tenantB,
    });
    expect(() =>
      reduceContactPolicy({
        actorTenantId: tenantA,
        facts: [offsetAllow, wrongTenantFact],
        observedAt: now,
        reducerVersion: '1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CROSS_TENANT_ACCESS' }));
  });

  it('requires correlation before provider acceptance', () => {
    expect(() =>
      applyTransportFact({
        actorTenantId: tenantA,
        attempt,
        nextState: 'provider_accepted',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CORRELATION_REQUIRED' }));
    const accepted = applyTransportFact({
      actorTenantId: tenantA,
      attempt,
      nextState: 'provider_accepted',
      providerCorrelationDigest: keyedDigest,
    });
    expect(accepted.transportState).toBe('provider_accepted');
    const delivered = applyTransportFact({
      actorTenantId: tenantA,
      attempt: accepted,
      nextState: 'delivered',
    });
    expect(
      applyTransportFact({
        actorTenantId: tenantA,
        attempt: delivered,
        nextState: 'provider_accepted',
      }),
    ).toBe(delivered);
  });

  it('rejects duplicate effects and unsafe ordinary retry', () => {
    const foreignAttempt = sendAttemptSchema.parse({
      ...attempt,
      tenantId: tenantB,
      operationId: 'operation-foreign',
      attemptId: 'attempt-foreign',
    });
    expect(() =>
      assertEffectNotDuplicated(artifact, [foreignAttempt]),
    ).toThrowError(expect.objectContaining({ code: 'CROSS_TENANT_ACCESS' }));
    expect(() => assertEffectNotDuplicated(artifact, [attempt])).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_EFFECT' }),
    );
    const unknown = applyTransportFact({
      actorTenantId: tenantA,
      attempt,
      nextState: 'acceptance_unknown',
    });
    expect(() => assertOrdinaryRetryAllowed(unknown)).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_RETRY' }),
    );
    expect(
      reconcileAcceptanceUnknown({
        actorTenantId: tenantA,
        attempt: unknown,
        resolution: 'unresolved',
      }),
    ).toBe(unknown);

    const newPlan = actionPlanSchema.parse({
      ...actionPlan,
      actionPlanId: 'plan-b',
      canonicalHash: digestB,
      operations: [
        {
          ...actionPlan.operations[0],
          operationId: 'operation-b',
        },
      ],
    });
    const freshApproval = approvalSchema.parse({
      ...approval,
      approvalId: 'approval-b',
      actionPlanId: 'plan-b',
      actionPlanHash: digestB,
    });
    const acknowledgement = riskAcknowledgementSchema.parse({
      schemaVersion: '1',
      tenantId: tenantA,
      frozenOperationId: 'operation-a',
      newActionPlanId: 'plan-b',
      acknowledgedBy: 'user-a',
      risk: 'provider_may_have_already_accepted',
      acknowledgedAt: now,
    });
    expect(() =>
      assertRiskAcknowledgedResend({
        actorTenantId: tenantA,
        frozenAttempt: unknown,
        acknowledgement,
        newActionPlan: newPlan,
        freshApproval,
        observedAt: now,
      }),
    ).not.toThrow();
  });

  it('never accepts display-only sent as a transport fact', () => {
    expect(() =>
      applyTransportFact({
        actorTenantId: tenantA,
        attempt,
        nextState: 'sent' as never,
      }),
    ).toThrow(DomainInvariantError);
  });
});

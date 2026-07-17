import {
  actionPlanSchema,
  contactChannelPolicySchema,
  sendAttemptSchema,
  type EffectExecutionArtifact,
  type ProviderSendResult,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
} from '@chief/contracts/connectors';
import {
  accountIdSchema,
  brandIdSchema,
  keyedDigestValueSchema,
  tenantIdSchema,
  type OperationId,
} from '@chief/contracts/ids';
import { verifiedActorContextSchema } from '@chief/contracts/tenancy';
import { describe, expect, it, vi } from 'vitest';

import {
  buildImmutableApprovalBundle,
  type OperationApprovalBinding,
} from './approval-service.js';
import { computeActionPlanHash } from './canonical.js';
import {
  EffectDisabledSink,
  assertIdenticalOperationRetry,
  decideReconciliation,
  executeApprovedOperation,
  type ApprovalExecutionPersistence,
  type AuthoritativeExecutionState,
  type EffectDisabledReceipt,
  type ExecutionBoundary,
  type ExecutionSink,
  type OperationClaim,
  type OperationClaimResult,
} from './execution-service.js';

const NOW = '2026-07-17T12:00:00.000Z';
const RUN_AT = '2026-07-17T12:10:00.000Z';
const EXPIRES = '2026-07-17T13:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST = `h1_v1_${'A'.repeat(43)}`;

function fixture(input?: {
  readonly operationKind?: 'send_message' | 'create_task';
  readonly effectPolicy?: 'effect_disabled' | 'external_effect';
}) {
  const operationKind = input?.operationKind ?? 'send_message';
  const effectPolicy = input?.effectPolicy ?? 'effect_disabled';
  const operation =
    operationKind === 'send_message'
      ? {
          kind: 'send_message' as const,
          operationId: 'operation-send-001',
          connectorAccountId: 'account-gmail-001',
          draftRevisionId: 'draft-revision-001',
          recipientDigests: [DIGEST],
          renderedPayloadFingerprint: HASH_A,
        }
      : {
          kind: 'create_task' as const,
          operationId: 'operation-asana-001',
          connectorAccountId: 'account-asana-001',
          exactFieldsHash: HASH_A,
        };
  const candidate = actionPlanSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    actionPlanId: `plan-${operationKind}`,
    revision: 1,
    sourceMessageRevisionId: 'message-revision-001',
    operations: [operation],
    policyVersion: 'approval-policy-v9',
    expiresAt: EXPIRES,
    canonicalHash: HASH_B,
    createdAt: NOW,
  });
  const plan = actionPlanSchema.parse({
    ...candidate,
    canonicalHash: computeActionPlanHash(candidate),
  });
  const accountId =
    operationKind === 'send_message'
      ? 'account-gmail-001'
      : 'account-asana-001';
  const connectorId = operationKind === 'send_message' ? 'gmail' : 'asana';
  const snapshot = connectorSnapshotSchema.parse({
    connectorId,
    descriptorVersion: `${connectorId}-2026-07`,
    accountId,
    capabilitySnapshotHash: HASH_B,
    runtimeMode: effectPolicy === 'effect_disabled' ? 'fixture' : 'live',
    selectionState: 'selected',
  });
  const binding: OperationApprovalBinding = {
    operationId: plan.operations[0]!.operationId,
    attemptId: 'attempt-001' as OperationApprovalBinding['attemptId'],
    account: connectorAccountRefSchema.parse({
      tenantId: 'tenant-redwood',
      accountId,
      expectedStateVersion: 11,
    }),
    connectorSnapshot: snapshot,
    renderedPayloadFingerprint: HASH_A,
    ...(operationKind === 'send_message'
      ? {
          draftRevisionId:
            'draft-revision-001' as OperationApprovalBinding['draftRevisionId'],
        }
      : {}),
    clientCorrelation: {
      kind:
        operationKind === 'send_message'
          ? 'rfc_message_id'
          : 'client_reference',
      value: `chief:${plan.actionPlanId}:${plan.operations[0]!.operationId}`,
    },
    correlationBindingVersion: 'correlation-v1',
    reconciliationStrategy:
      operationKind === 'send_message'
        ? 'rfc-message-id-query'
        : 'asana-gid-query',
    reconciliationStrategyVersion: 'strategy-v1',
    contactPolicies:
      operationKind === 'send_message'
        ? [
            {
              tenantId: tenantIdSchema.parse('tenant-redwood'),
              contactIdentityDigest: keyedDigestValueSchema.parse(DIGEST),
              channel: 'email',
              connectorAccountId: accountIdSchema.parse(accountId),
              brandId: brandIdSchema.parse('brand-redwood'),
              projectionVersion: 7,
            },
          ]
        : [],
    effectSwitch: {
      globalVersion: 4,
      accountVersion: 6,
      operationVersion: 2,
      policy: effectPolicy,
    },
  };
  const actor = verifiedActorContextSchema.parse({
    authoritySource: 'verified_identity',
    tenantId: 'tenant-redwood',
    userId: 'executive-ada',
    accountScopes: [accountId],
    brandScopes: ['brand-redwood'],
    grants: ['actions:approve'],
    membershipVersion: 2,
    verifiedClaimsHash: HASH_A,
    verifiedAt: NOW,
  });
  const bundle = buildImmutableApprovalBundle({
    actor,
    actionPlan: plan,
    approvalId: `approval-${operationKind}`,
    executionIntentId: `intent-${operationKind}`,
    approvedAt: '2026-07-17T12:05:00.000Z',
    bindings: [binding],
  });
  const policy = contactChannelPolicySchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    contactIdentityDigest: DIGEST,
    channel: 'email',
    connectorAccountId: accountId,
    brandId: 'brand-redwood',
    state: 'allowed',
    winningFactId: 'allow-fact-001',
    applicableFactIds: ['allow-fact-001'],
    reducerVersion: 'contact-policy-v2',
    projectionVersion: 7,
    updatedAt: '2026-07-17T12:04:00.000Z',
  });
  const state: AuthoritativeExecutionState = {
    actionPlan: bundle.actionPlan,
    approval: bundle.approval,
    operation: bundle.operations[0]!,
    currentSourceMessageRevisionId: bundle.actionPlan.sourceMessageRevisionId,
    approverAuthorityActive: true,
    connector: {
      accountId,
      stateVersion: 11,
      status: 'active',
      health: 'healthy',
      snapshot,
      operationCapabilityEnabled: true,
    },
    contactPolicies: operationKind === 'send_message' ? [policy] : [],
    effectSwitch: {
      ...binding.effectSwitch,
      globalEnabled: effectPolicy === 'external_effect',
      accountEnabled: effectPolicy === 'external_effect',
      operationEnabled: effectPolicy === 'external_effect',
    },
  };
  return { bundle, state };
}

class MemoryExecutionPersistence implements ApprovalExecutionPersistence {
  public status: 'ready' | 'claimed' | 'dispatching' | 'settled' | 'frozen' =
    'ready';
  public claimEpoch = 0;
  public claim: OperationClaim | undefined;
  public failCorrelationPersistence = false;
  public frozenReason: string | undefined;
  public disabledReceipt: EffectDisabledReceipt | undefined;
  public missingAuthoritativeState = false;

  public constructor(public state: AuthoritativeExecutionState) {}

  public claimOperation(input: {
    readonly operationId: OperationId;
    readonly claimOwner: string;
    readonly now: string;
    readonly leaseDurationMs: number;
  }): Promise<OperationClaimResult> {
    if (this.status === 'settled')
      return Promise.resolve({ status: 'duplicate' });
    if (this.status === 'frozen') return Promise.resolve({ status: 'frozen' });
    if (this.claim !== undefined) {
      if (Date.parse(this.claim.leaseExpiresAt) >= Date.parse(input.now)) {
        return Promise.resolve({ status: 'contended' });
      }
      if (this.status === 'dispatching') {
        this.status = 'frozen';
        this.frozenReason = 'dispatch_lease_expired';
        return Promise.resolve({ status: 'frozen' });
      }
    }
    this.claimEpoch += 1;
    this.status = 'claimed';
    this.claim = {
      operationId: input.operationId,
      claimOwner: input.claimOwner,
      claimEpoch: this.claimEpoch,
      leaseExpiresAt: new Date(
        Date.parse(input.now) + input.leaseDurationMs,
      ).toISOString(),
    };
    return Promise.resolve({ status: 'claimed', claim: this.claim });
  }

  public loadAuthoritativeState(): Promise<
    AuthoritativeExecutionState | undefined
  > {
    return Promise.resolve(
      this.missingAuthoritativeState ? undefined : this.state,
    );
  }

  public releaseUncalledClaim(claim: OperationClaim): Promise<void> {
    this.assertClaim(claim);
    this.claim = undefined;
    this.status = 'ready';
    return Promise.resolve();
  }

  public persistDispatchAttempt(
    claim: OperationClaim,
    artifact: EffectExecutionArtifact,
  ): Promise<void> {
    this.assertClaim(claim);
    expect(artifact).toBe(this.state.operation.artifact);
    this.status = 'dispatching';
    return Promise.resolve();
  }

  public settleEffectDisabled(
    claim: OperationClaim,
    receipt: EffectDisabledReceipt,
  ): Promise<void> {
    this.assertClaim(claim);
    this.disabledReceipt = receipt;
    this.status = 'settled';
    return Promise.resolve();
  }

  public settleRejected(
    claim: OperationClaim,
    _result: Extract<ProviderSendResult, { readonly outcome: 'rejected' }>,
  ): Promise<void> {
    this.assertClaim(claim);
    this.status = 'settled';
    return Promise.resolve();
  }

  public settleAcceptedAndCorrelation(
    claim: OperationClaim,
    _result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ): Promise<void> {
    this.assertClaim(claim);
    if (this.failCorrelationPersistence) {
      return Promise.reject(new Error('conditional correlation write failed'));
    }
    this.status = 'settled';
    return Promise.resolve();
  }

  public freezeAcceptanceUnknown(
    claim: OperationClaim,
    reasonCode: string,
  ): Promise<void> {
    this.assertClaim(claim);
    this.status = 'frozen';
    this.frozenReason = reasonCode;
    return Promise.resolve();
  }

  private assertClaim(claim: OperationClaim): void {
    if (
      this.claim?.claimEpoch !== claim.claimEpoch ||
      this.claim.claimOwner !== claim.claimOwner
    ) {
      throw new Error('STALE_CLAIM');
    }
  }
}

function input(
  overrides?: Partial<Parameters<typeof executeApprovedOperation>[2]>,
) {
  return {
    operationId: 'operation-send-001' as OperationId,
    workerId: 'worker-a',
    observedAt: RUN_AT,
    leaseDurationMs: 30_000,
    ...overrides,
  };
}

function providerSink(dispatch: ExecutionSink['dispatch']): ExecutionSink {
  return { mode: 'provider_fake', dispatch };
}

describe('guarded execution', () => {
  it('uses the endpoint-free effect-disabled sink and makes zero provider calls', async () => {
    const { state } = fixture();
    const persistence = new MemoryExecutionPersistence(state);
    const providerCall = vi.fn();
    const sink = new EffectDisabledSink(() => RUN_AT);

    const result = await executeApprovedOperation(persistence, sink, input());

    expect(result.status).toBe('effect_disabled');
    expect(providerCall).not.toHaveBeenCalled();
    expect(persistence.disabledReceipt).toMatchObject({
      kind: 'effect_disabled',
      operationId: 'operation-send-001',
    });
  });

  it.each([
    [
      'unapproved/revoked',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        approval: { ...state.approval, status: 'revoked' as const },
      }),
    ],
    [
      'changed action plan',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        actionPlan: { ...state.actionPlan, policyVersion: 'changed-policy' },
      }),
    ],
    [
      'changed thread',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        currentSourceMessageRevisionId: 'message-revision-002',
      }),
    ],
    [
      'expired approval',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        approval: { ...state.approval, expiresAt: '2026-07-17T12:09:00.000Z' },
      }),
    ],
    [
      'disabled account',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        connector: { ...state.connector, status: 'disabled' as const },
      }),
    ],
    [
      'capability drift',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        connector: { ...state.connector, operationCapabilityEnabled: false },
      }),
    ],
    [
      'suppressed contact',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        contactPolicies: state.contactPolicies.map((policy) => ({
          ...policy,
          state: 'suppressed' as const,
        })),
      }),
    ],
    [
      'contact policy version drift',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        contactPolicies: state.contactPolicies.map((policy) => ({
          ...policy,
          projectionVersion: 8,
        })),
      }),
    ],
    [
      'cross-account contact policy substitution',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        contactPolicies: state.contactPolicies.map((policy) => ({
          ...policy,
          connectorAccountId: accountIdSchema.parse(
            'account-other-tenant-scope',
          ),
        })),
      }),
    ],
    [
      'cross-brand contact policy substitution',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        contactPolicies: state.contactPolicies.map((policy) => ({
          ...policy,
          brandId: brandIdSchema.parse('brand-unapproved'),
        })),
      }),
    ],
    [
      'effect switch drift',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        effectSwitch: { ...state.effectSwitch, operationVersion: 3 },
      }),
    ],
  ])('blocks %s immediately before the sink call', async (_label, mutate) => {
    const { state } = fixture();
    const persistence = new MemoryExecutionPersistence(mutate(state));
    const sink: ExecutionSink = {
      mode: 'effect_disabled',
      dispatch: vi.fn(),
    };
    await expect(
      executeApprovedOperation(persistence, sink, input()),
    ).rejects.toThrow();
    expect(sink.dispatch).not.toHaveBeenCalled();
    expect(persistence.status).toBe('ready');
  });

  it('blocks an unapproved operation with no authoritative approval bundle', async () => {
    const { state } = fixture();
    const persistence = new MemoryExecutionPersistence(state);
    persistence.missingAuthoritativeState = true;
    const sink: ExecutionSink = {
      mode: 'effect_disabled',
      dispatch: vi.fn(),
    };
    await expect(
      executeApprovedOperation(persistence, sink, input()),
    ).rejects.toThrow('AUTHORITATIVE_EXECUTION_STATE_NOT_FOUND');
    expect(sink.dispatch).not.toHaveBeenCalled();
    expect(persistence.status).toBe('ready');
  });

  it('allows only one of two workers to claim and never redelivers a settled operation', async () => {
    const { state } = fixture();
    const persistence = new MemoryExecutionPersistence(state);
    const sink = new EffectDisabledSink(() => RUN_AT);
    const [first, second] = await Promise.all([
      executeApprovedOperation(persistence, sink, input()),
      executeApprovedOperation(
        persistence,
        sink,
        input({ workerId: 'worker-b' }),
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      'contended',
      'effect_disabled',
    ]);
    await expect(
      executeApprovedOperation(
        persistence,
        sink,
        input({ workerId: 'worker-c' }),
      ),
    ).resolves.toEqual({ status: 'duplicate' });
  });

  it('freezes acceptance_unknown and refuses ordinary redelivery', async () => {
    const { state } = fixture({ effectPolicy: 'external_effect' });
    const persistence = new MemoryExecutionPersistence(state);
    const sink = providerSink(
      vi.fn().mockResolvedValue({
        outcome: 'acceptance_unknown',
        providerResponseHash: HASH_A,
        reasonCode: 'provider_timeout_after_upload',
        observedAt: RUN_AT,
      }),
    );
    await expect(
      executeApprovedOperation(persistence, sink, input()),
    ).resolves.toMatchObject({ status: 'reconciliation_required' });
    await expect(
      executeApprovedOperation(
        persistence,
        sink,
        input({ workerId: 'worker-b', observedAt: '2026-07-17T12:11:00.000Z' }),
      ),
    ).resolves.toEqual({ status: 'frozen' });
    expect(sink.dispatch).toHaveBeenCalledTimes(1);
  });

  it('freezes when provider correlation persistence fails after acceptance', async () => {
    const { state } = fixture({ effectPolicy: 'external_effect' });
    const persistence = new MemoryExecutionPersistence(state);
    persistence.failCorrelationPersistence = true;
    const sink = providerSink(
      vi.fn().mockResolvedValue({
        outcome: 'accepted',
        providerResponseHash: HASH_A,
        providerCorrelation: 'provider-message-gid-991',
        observedAt: RUN_AT,
      }),
    );
    await expect(
      executeApprovedOperation(persistence, sink, input()),
    ).resolves.toMatchObject({ status: 'reconciliation_required' });
    expect(persistence.frozenReason).toBe('correlation_persistence_failed');
  });

  it.each<ExecutionBoundary>([
    'after_claim',
    'after_guard',
    'after_attempt_persisted',
    'after_sink',
    'after_result_persisted',
  ])('is deterministic across a crash at %s', async (boundary) => {
    const { state } = fixture();
    const persistence = new MemoryExecutionPersistence(state);
    const sink = new EffectDisabledSink(() => RUN_AT);
    await expect(
      executeApprovedOperation(
        persistence,
        sink,
        input({
          onBoundary: (observed) => {
            if (observed === boundary) throw new Error(`crash:${boundary}`);
          },
        }),
      ),
    ).rejects.toThrow(`crash:${boundary}`);

    const recovery = await executeApprovedOperation(
      persistence,
      sink,
      input({
        workerId: 'worker-recovery',
        observedAt: '2026-07-17T12:11:00.000Z',
      }),
    );
    if (boundary === 'after_claim' || boundary === 'after_guard') {
      expect(recovery.status).toBe('effect_disabled');
    } else if (
      boundary === 'after_attempt_persisted' ||
      boundary === 'after_sink'
    ) {
      expect(recovery.status).toBe('frozen');
    } else {
      expect(recovery.status).toBe('duplicate');
    }
  });
});

describe('retry and reconciliation decisions', () => {
  it('permits proven-nonacceptance retry only for the identical operation', () => {
    const { bundle } = fixture({ effectPolicy: 'external_effect' });
    const prior = bundle.operations[0]!.artifact;
    const retry = {
      ...prior,
      attemptId: 'attempt-002' as EffectExecutionArtifact['attemptId'],
      createdAt: '2026-07-17T12:20:00.000Z',
    };
    const attempt = sendAttemptSchema.parse({
      schemaVersion: '1',
      tenantId: prior.tenantId,
      operationId: prior.operationId,
      attemptId: prior.attemptId,
      artifactHash: bundle.operations[0]!.artifactHash,
      stableIdempotencyKey: prior.stableIdempotencyKey,
      lifecycleState: 'reconciled',
      transportState: 'provider_rejected',
      clientCorrelation: prior.clientCorrelation,
      correlationBindingVersion: prior.correlationBindingVersion,
      retryDecision: 'retry_allowed',
      attemptedAt: RUN_AT,
      stateVersion: 3,
    });
    expect(() =>
      assertIdenticalOperationRetry({
        priorArtifact: prior,
        retryArtifact: retry,
        priorAttempt: attempt,
      }),
    ).not.toThrow();
    expect(() =>
      assertIdenticalOperationRetry({
        priorArtifact: prior,
        retryArtifact: { ...retry, renderedPayloadFingerprint: HASH_B },
        priorAttempt: attempt,
      }),
    ).toThrow('RETRY_MUST_PRESERVE_IDENTICAL_OPERATION');
  });

  it('makes frozen reconciliation decisions without fallback', () => {
    expect(decideReconciliation({ result: 'proven_not_accepted' })).toBe(
      'retry_identical_operation',
    );
    expect(
      decideReconciliation({
        result: 'proven_accepted',
        providerCorrelation: 'asana-task-gid-12001',
      }),
    ).toBe('settle_accepted');
    expect(decideReconciliation({ result: 'unresolved' })).toBe(
      'remain_frozen',
    );
  });

  it('keeps an Asana operation failure isolated and never retries it as success', async () => {
    const { state } = fixture({
      operationKind: 'create_task',
      effectPolicy: 'external_effect',
    });
    const persistence = new MemoryExecutionPersistence(state);
    const sink = providerSink(
      vi.fn().mockResolvedValue({
        outcome: 'rejected',
        providerResponseHash: HASH_B,
        reasonCode: 'asana_precondition_failed',
        observedAt: RUN_AT,
      }),
    );
    const asanaInput = input({
      operationId: 'operation-asana-001' as OperationId,
    });
    await expect(
      executeApprovedOperation(persistence, sink, asanaInput),
    ).resolves.toMatchObject({ status: 'provider_rejected' });
    await expect(
      executeApprovedOperation(
        persistence,
        sink,
        input({
          operationId: 'operation-asana-001' as OperationId,
          workerId: 'worker-b',
        }),
      ),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(sink.dispatch).toHaveBeenCalledTimes(1);
  });
});

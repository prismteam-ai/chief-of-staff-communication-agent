import {
  actionPlanSchema,
  contactChannelPolicySchema,
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
import {
  buildImmutableApprovalBundle,
  type OperationApprovalBinding,
} from '@chief/approval-outbox/approval-service';
import { computeActionPlanHash } from '@chief/approval-outbox/canonical';
import type {
  AuthoritativeExecutionState,
  EffectDisabledReceipt,
  OperationClaim,
  OperationClaimResult,
} from '@chief/approval-outbox/execution-service';
import type {
  CommunicationConnector,
  WorkManagementConnector,
} from '@chief/connector-core';
import { describe, expect, it, vi } from 'vitest';

import { createApprovalExecutionWorker } from './execution-worker.js';
import type {
  ClaimHeartbeatPersistence,
  EffectConnectorSelector,
  PreDispatchOutcome,
} from './provider-execution.js';
import {
  GuardedProviderExecutionSink,
  PreDispatchDeniedError,
} from './provider-execution.js';
import {
  DefaultDenyRuntimeEffectPolicy,
  ExactEnvelopeRuntimeEffectPolicy,
  type ControlledEffectEnvelope,
} from './runtime-policy.js';
import { createSqsExecutionHandler } from './sqs-handler.js';

const NOW = '2026-07-17T12:00:00.000Z';
const RUN_AT = '2026-07-17T12:10:00.000Z';
const EXPIRES = '2026-07-17T13:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST = `h1_v1_${'A'.repeat(43)}`;

function fixture(effectPolicy: 'effect_disabled' | 'external_effect') {
  const operation = {
    kind: 'send_message' as const,
    operationId: 'operation-send-001',
    connectorAccountId: 'account-gmail-001',
    draftRevisionId: 'draft-revision-001',
    recipientDigests: [DIGEST],
    renderedPayloadFingerprint: HASH_A,
  };
  const candidate = actionPlanSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    actionPlanId: 'plan-send-001',
    revision: 1,
    sourceMessageRevisionId: 'message-revision-001',
    operations: [operation],
    policyVersion: 'approval-policy-v9',
    expiresAt: EXPIRES,
    canonicalHash: HASH_B,
    createdAt: NOW,
  });
  const actionPlan = actionPlanSchema.parse({
    ...candidate,
    canonicalHash: computeActionPlanHash(candidate),
  });
  const snapshot = connectorSnapshotSchema.parse({
    connectorId: 'gmail',
    descriptorVersion: 'gmail-2026-07',
    accountId: 'account-gmail-001',
    capabilitySnapshotHash: HASH_B,
    runtimeMode: effectPolicy === 'effect_disabled' ? 'fixture' : 'live',
    selectionState: 'selected',
  });
  const binding: OperationApprovalBinding = {
    operationId: actionPlan.operations[0]!.operationId,
    attemptId: 'attempt-001' as OperationApprovalBinding['attemptId'],
    account: connectorAccountRefSchema.parse({
      tenantId: 'tenant-redwood',
      accountId: 'account-gmail-001',
      expectedStateVersion: 11,
    }),
    connectorSnapshot: snapshot,
    renderedPayloadFingerprint: HASH_A,
    draftRevisionId:
      'draft-revision-001' as OperationApprovalBinding['draftRevisionId'],
    clientCorrelation: {
      kind: 'rfc_message_id',
      value: '<chief-operation-send-001@example.test>',
    },
    correlationBindingVersion: 'correlation-v1',
    reconciliationStrategy: 'gmail_sent_rfc_message_id',
    reconciliationStrategyVersion: '1',
    contactPolicies: [
      {
        tenantId: tenantIdSchema.parse('tenant-redwood'),
        contactIdentityDigest: keyedDigestValueSchema.parse(DIGEST),
        channel: 'email',
        connectorAccountId: accountIdSchema.parse('account-gmail-001'),
        brandId: brandIdSchema.parse('brand-redwood'),
        projectionVersion: 7,
      },
    ],
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
    accountScopes: ['account-gmail-001'],
    brandScopes: ['brand-redwood'],
    grants: ['actions:approve'],
    membershipVersion: 2,
    verifiedClaimsHash: HASH_A,
    verifiedAt: NOW,
  });
  const bundle = buildImmutableApprovalBundle({
    actor,
    actionPlan,
    approvalId: 'approval-send-001',
    executionIntentId: 'intent-send-001',
    approvedAt: '2026-07-17T12:05:00.000Z',
    bindings: [binding],
  });
  const policy = contactChannelPolicySchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    contactIdentityDigest: DIGEST,
    channel: 'email',
    connectorAccountId: 'account-gmail-001',
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
    currentSourceMessageRevisionId: actionPlan.sourceMessageRevisionId,
    approverAuthorityActive: true,
    connector: {
      accountId: 'account-gmail-001',
      stateVersion: 11,
      status: 'active',
      health: 'healthy',
      snapshot,
      operationCapabilityEnabled: true,
    },
    contactPolicies: [policy],
    effectSwitch: {
      ...binding.effectSwitch,
      globalEnabled: effectPolicy === 'external_effect',
      accountEnabled: effectPolicy === 'external_effect',
      operationEnabled: effectPolicy === 'external_effect',
    },
  };
  const envelope: ControlledEffectEnvelope = {
    kind: 'communication',
    operation: 'send_message',
    tenantId: state.operation.artifact.tenantId,
    operationId: state.operation.artifact.operationId,
    actionPlanHash: state.operation.artifact.actionPlanHash,
    accountId: state.operation.artifact.account.accountId,
    connectorId: state.operation.artifact.connectorSnapshot.connectorId,
    descriptorVersion:
      state.operation.artifact.connectorSnapshot.descriptorVersion,
    capabilitySnapshotHash:
      state.operation.artifact.connectorSnapshot.capabilitySnapshotHash,
    renderedPayloadFingerprint:
      state.operation.artifact.renderedPayloadFingerprint,
  };
  return { state, envelope };
}

class MemoryPersistence implements ClaimHeartbeatPersistence {
  public status: 'ready' | 'claimed' | 'dispatching' | 'settled' | 'frozen' =
    'ready';
  public claimEpoch = 0;
  public claim: OperationClaim | undefined;
  public disabledReceipt: EffectDisabledReceipt | undefined;
  public frozenReason: string | undefined;
  public failHeartbeat = false;
  public suppressAfterAttemptPersistence = false;
  public failFinalBoundaryWithInfrastructure = false;
  public events: string[] = [];
  public workManagementLinks: string[] = [];
  public preDispatchOutcomes: PreDispatchOutcome[] = [];

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
      this.claim = undefined;
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

  public loadAuthoritativeState(): Promise<AuthoritativeExecutionState> {
    return Promise.resolve(this.state);
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
    expect(artifact.clientCorrelation.value).toContain('operation-send-001');
    this.events.push('client_correlation_persisted');
    this.status = 'dispatching';
    if (this.suppressAfterAttemptPersistence) {
      this.state = {
        ...this.state,
        contactPolicies: this.state.contactPolicies.map((policy) => ({
          ...policy,
          state: 'suppressed' as const,
        })),
      };
    }
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
    _result: Extract<ProviderSendResult, { outcome: 'rejected' }>,
  ): Promise<void> {
    this.assertClaim(claim);
    this.status = 'settled';
    return Promise.resolve();
  }

  public settleAcceptedAndCorrelation(
    claim: OperationClaim,
    _result: Extract<ProviderSendResult, { outcome: 'accepted' }>,
  ): Promise<void> {
    this.assertClaim(claim);
    this.events.push('provider_correlation_persisted');
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

  public heartbeatClaim(input: {
    readonly claim: OperationClaim;
    readonly observedAt: string;
    readonly leaseDurationMs: number;
  }): Promise<'renewed' | 'lost'> {
    this.assertClaim(input.claim);
    this.events.push(`heartbeat:${String(input.claim.claimEpoch)}`);
    if (this.failHeartbeat) return Promise.resolve('lost');
    this.claim = {
      ...input.claim,
      leaseExpiresAt: new Date(
        Date.parse(input.observedAt) + input.leaseDurationMs,
      ).toISOString(),
    };
    return Promise.resolve('renewed');
  }

  public assertProviderBoundaryCurrent(input: {
    readonly claim: OperationClaim;
    readonly artifact: EffectExecutionArtifact;
    readonly envelope: ControlledEffectEnvelope;
  }): Promise<void> {
    this.assertClaim(input.claim);
    if (
      input.artifact.tenantId !== input.envelope.tenantId ||
      input.artifact.account.accountId !== input.envelope.accountId
    ) {
      return Promise.reject(new Error('PROVIDER_BOUNDARY_SCOPE_MISMATCH'));
    }
    if (
      this.state.contactPolicies.some((policy) => policy.state !== 'allowed') ||
      !this.state.effectSwitch.globalEnabled ||
      !this.state.effectSwitch.accountEnabled ||
      !this.state.effectSwitch.operationEnabled
    ) {
      return Promise.reject(
        new PreDispatchDeniedError('PROVIDER_BOUNDARY_AUTHORITY_CHANGED'),
      );
    }
    if (
      this.failFinalBoundaryWithInfrastructure &&
      this.status === 'dispatching'
    ) {
      return Promise.reject(
        new Error(
          'table=private-chief-execution requestToken=top-secret-token',
        ),
      );
    }
    this.events.push('provider_boundary_rechecked');
    return Promise.resolve();
  }

  public settlePreDispatchDenied(input: {
    readonly claim: OperationClaim;
    readonly outcome: PreDispatchOutcome & { readonly disposition: 'denied' };
  }): Promise<void> {
    this.assertClaim(input.claim);
    this.preDispatchOutcomes.push(input.outcome);
    this.status = 'settled';
    return Promise.resolve();
  }

  public settlePreDispatchRetryable(input: {
    readonly claim: OperationClaim;
    readonly outcome: PreDispatchOutcome & {
      readonly disposition: 'retryable';
    };
  }): Promise<void> {
    this.assertClaim(input.claim);
    this.preDispatchOutcomes.push(input.outcome);
    this.claim = undefined;
    this.status = 'ready';
    return Promise.resolve();
  }

  public settleAcceptedWorkManagementEffect(input: {
    readonly claim: OperationClaim;
    readonly artifact: EffectExecutionArtifact;
    readonly result: Extract<ProviderSendResult, { outcome: 'accepted' }>;
  }): Promise<void> {
    this.assertClaim(input.claim);
    this.workManagementLinks.push(input.result.providerCorrelation);
    this.status = 'settled';
    return Promise.resolve();
  }

  private assertClaim(claim: OperationClaim): void {
    if (
      this.claim?.claimOwner !== claim.claimOwner ||
      this.claim.claimEpoch !== claim.claimEpoch
    ) {
      throw new Error('STALE_CLAIM_EPOCH');
    }
  }
}

function connectors(
  send: (artifact: EffectExecutionArtifact) => Promise<ProviderSendResult>,
): EffectConnectorSelector {
  return {
    communication: () =>
      ({
        descriptor: () => ({
          connectorId: 'gmail',
          descriptorVersion: 'gmail-2026-07',
          supportedRuntimeModes: ['live'],
          capabilities: { send: true, externalEffect: true },
        }),
        send: (_account: unknown, artifact: EffectExecutionArtifact) =>
          send(artifact),
      }) as unknown as CommunicationConnector,
    workManagement: () => ({}) as WorkManagementConnector,
  };
}

function workerEvent(operationId = 'operation-send-001' as OperationId) {
  return {
    operationId,
    workerId: 'worker-a',
    observedAt: RUN_AT,
    leaseDurationMs: 30_000,
  };
}

describe('execution worker', () => {
  it('runs the complete truthful effect-disabled path without a connector', async () => {
    const { state } = fixture('effect_disabled');
    const persistence = new MemoryPersistence(state);
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
    });

    await expect(worker(workerEvent())).resolves.toMatchObject({
      status: 'effect_disabled',
      receipt: { kind: 'effect_disabled' },
    });
    expect(persistence.disabledReceipt).toMatchObject({
      operationId: 'operation-send-001',
      stableIdempotencyKey: state.operation.artifact.stableIdempotencyKey,
    });
    await expect(worker(workerEvent())).resolves.toEqual({
      status: 'duplicate',
    });
  });

  it('allows a pre-dispatch lease takeover with a new epoch but freezes an expired dispatch', async () => {
    const { state } = fixture('effect_disabled');
    const persistence = new MemoryPersistence(state);
    persistence.status = 'claimed';
    persistence.claimEpoch = 1;
    persistence.claim = {
      operationId: state.operation.artifact.operationId,
      claimOwner: 'dead-worker',
      claimEpoch: 1,
      leaseExpiresAt: '2026-07-17T12:09:00.000Z',
    };
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
    });
    await expect(worker(workerEvent())).resolves.toMatchObject({
      status: 'effect_disabled',
    });
    expect(persistence.claimEpoch).toBe(2);

    const dispatching = new MemoryPersistence(state);
    dispatching.status = 'dispatching';
    dispatching.claimEpoch = 1;
    dispatching.claim = {
      operationId: state.operation.artifact.operationId,
      claimOwner: 'dead-worker',
      claimEpoch: 1,
      leaseExpiresAt: '2026-07-17T12:09:00.000Z',
    };
    const frozenWorker = createApprovalExecutionWorker({
      persistence: dispatching,
      now: () => RUN_AT,
    });
    await expect(frozenWorker(workerEvent())).resolves.toEqual({
      status: 'frozen',
    });
    expect(dispatching.frozenReason).toBe('dispatch_lease_expired');
  });

  it('persists correlation, rechecks the exact boundary, heartbeats, and then calls one adapter', async () => {
    const { state, envelope } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    const send = vi.fn(() => {
      persistence.events.push('provider_called');
      return Promise.resolve({
        outcome: 'accepted' as const,
        providerResponseHash: HASH_A,
        providerCorrelation: 'gmail-message-991',
        observedAt: RUN_AT,
      });
    });
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new ExactEnvelopeRuntimeEffectPolicy([envelope]),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });

    await expect(worker(workerEvent())).resolves.toMatchObject({
      status: 'provider_accepted',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      persistence.events.indexOf('provider_boundary_rechecked'),
    ).toBeLessThan(persistence.events.indexOf('client_correlation_persisted'));
    expect(
      persistence.events.indexOf('client_correlation_persisted'),
    ).toBeLessThan(persistence.events.indexOf('provider_called'));
    const finalBoundary = persistence.events.lastIndexOf(
      'provider_boundary_rechecked',
    );
    expect(
      persistence.events.filter(
        (entry) => entry === 'provider_boundary_rechecked',
      ),
    ).toHaveLength(2);
    expect(finalBoundary).toBeGreaterThan(
      persistence.events.indexOf('client_correlation_persisted'),
    );
    expect(persistence.events[finalBoundary + 1]).toBe('provider_called');
    expect(persistence.events.at(-1)).toBe('provider_correlation_persisted');
  });

  it('blocks a suppression race after attempt persistence at the final provider boundary', async () => {
    const { state, envelope } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    persistence.suppressAfterAttemptPersistence = true;
    const send = vi.fn<() => Promise<ProviderSendResult>>();
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new ExactEnvelopeRuntimeEffectPolicy([envelope]),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });

    await expect(worker(workerEvent())).resolves.toEqual({
      status: 'pre_dispatch_denied',
      reasonCode: 'PROVIDER_BOUNDARY_AUTHORITY_CHANGED',
    });
    expect(persistence.events).toContain('client_correlation_persisted');
    expect(send).not.toHaveBeenCalled();
    expect(persistence.status).toBe('settled');
    expect(persistence.frozenReason).toBeUndefined();
    expect(persistence.preDispatchOutcomes).toEqual([
      expect.objectContaining({
        disposition: 'denied',
        reasonCode: 'PROVIDER_BOUNDARY_AUTHORITY_CHANGED',
      }),
    ]);
  });

  it('returns a retryable uncalled outcome for final-boundary infrastructure failure', async () => {
    const { state, envelope } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    persistence.failFinalBoundaryWithInfrastructure = true;
    const send = vi.fn<() => Promise<ProviderSendResult>>();
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new ExactEnvelopeRuntimeEffectPolicy([envelope]),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });

    await expect(worker(workerEvent())).resolves.toEqual({
      status: 'pre_dispatch_retryable',
      reasonCode: 'PRE_DISPATCH_INFRASTRUCTURE_FAILURE',
    });
    expect(send).not.toHaveBeenCalled();
    expect(persistence.status).toBe('ready');
    expect(persistence.frozenReason).toBeUndefined();
    expect(persistence.preDispatchOutcomes).toEqual([
      expect.objectContaining({
        disposition: 'retryable',
        reasonCode: 'PRE_DISPATCH_INFRASTRUCTURE_FAILURE',
      }),
    ]);
    expect(JSON.stringify(persistence.preDispatchOutcomes)).not.toContain(
      'top-secret-token',
    );
  });

  it('defaults every external provider effect off even when a live adapter is injected', async () => {
    const { state } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    const send = vi.fn<() => Promise<ProviderSendResult>>();
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new DefaultDenyRuntimeEffectPolicy(),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });

    await expect(worker(workerEvent())).rejects.toThrow(
      'EXACT_EXTERNAL_EFFECT_NOT_ENABLED',
    );
    expect(send).not.toHaveBeenCalled();
    expect(persistence.status).toBe('ready');
  });

  it.each([
    [
      'stale approval',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        approval: { ...state.approval, status: 'revoked' as const },
      }),
    ],
    [
      'edited draft/action plan',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        actionPlan: { ...state.actionPlan, policyVersion: 'changed' },
      }),
    ],
    [
      'new inbound message',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        currentSourceMessageRevisionId: 'message-revision-002',
      }),
    ],
    [
      'new suppression',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        contactPolicies: state.contactPolicies.map((policy) => ({
          ...policy,
          state: 'suppressed' as const,
        })),
      }),
    ],
    [
      'cross-account substitution',
      (state: AuthoritativeExecutionState) => ({
        ...state,
        connector: { ...state.connector, accountId: 'account-attacker' },
      }),
    ],
  ] as const)('denies %s before provider dispatch', async (_label, mutate) => {
    const { state, envelope } = fixture('external_effect');
    const persistence = new MemoryPersistence(mutate(state));
    const send = vi.fn<() => Promise<ProviderSendResult>>();
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new ExactEnvelopeRuntimeEffectPolicy([envelope]),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });
    await expect(worker(workerEvent())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('stops before dispatch when the exact lease epoch is lost', async () => {
    const { state, envelope } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    persistence.failHeartbeat = true;
    const send = vi.fn<() => Promise<ProviderSendResult>>();
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new ExactEnvelopeRuntimeEffectPolicy([envelope]),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });
    await expect(worker(workerEvent())).resolves.toMatchObject({
      status: 'pre_dispatch_retryable',
    });
    expect(send).not.toHaveBeenCalled();
    expect(persistence.frozenReason).toBeUndefined();
  });

  it('freezes an ambiguous acceptance and makes duplicate delivery non-effectful', async () => {
    const { state, envelope } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    const send = vi.fn(() =>
      Promise.resolve({
        outcome: 'acceptance_unknown' as const,
        reasonCode: 'provider_timeout',
        observedAt: RUN_AT,
      }),
    );
    const worker = createApprovalExecutionWorker({
      persistence,
      now: () => RUN_AT,
      providerEffects: {
        policy: new ExactEnvelopeRuntimeEffectPolicy([envelope]),
        connectors: connectors(send),
        heartbeatIntervalMs: 5_000,
      },
    });
    await expect(worker(workerEvent())).resolves.toMatchObject({
      status: 'reconciliation_required',
    });
    await expect(worker(workerEvent())).resolves.toEqual({ status: 'frozen' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('executes only the exact enabled Asana operation and links its acceptance', async () => {
    const { state } = fixture('external_effect');
    const persistence = new MemoryPersistence(state);
    const asanaArtifact: EffectExecutionArtifact = {
      ...state.operation.artifact,
      operationId:
        'operation-asana-001' as EffectExecutionArtifact['operationId'],
      account: {
        ...state.operation.artifact.account,
        accountId: accountIdSchema.parse('account-asana-001'),
      },
      connectorSnapshot: {
        ...state.operation.artifact.connectorSnapshot,
        connectorId: 'asana',
        descriptorVersion: 'asana-2026-07',
        accountId: accountIdSchema.parse('account-asana-001'),
      },
    };
    const claim: OperationClaim = {
      operationId: asanaArtifact.operationId,
      claimOwner: 'worker-a',
      claimEpoch: 1,
      leaseExpiresAt: '2026-07-17T12:20:00.000Z',
    };
    persistence.claim = claim;
    const workConnector = {
      descriptor: () => ({
        connectorId: 'asana',
        descriptorVersion: 'asana-2026-07',
        supportedRuntimeModes: ['live'],
        capabilities: {
          externalEffect: true,
          createTask: true,
          updateTask: false,
          createComment: false,
        },
      }),
      execute: vi.fn(() =>
        Promise.resolve({
          outcome: 'accepted' as const,
          providerResponseHash: HASH_A,
          providerCorrelation: 'asana-task-12001',
          observedAt: RUN_AT,
        }),
      ),
    } as unknown as WorkManagementConnector;
    const createEnvelope: ControlledEffectEnvelope = {
      kind: 'work_management',
      operation: 'create_task',
      tenantId: asanaArtifact.tenantId,
      operationId: asanaArtifact.operationId,
      actionPlanHash: asanaArtifact.actionPlanHash,
      accountId: asanaArtifact.account.accountId,
      connectorId: 'asana',
      descriptorVersion: 'asana-2026-07',
      capabilitySnapshotHash:
        asanaArtifact.connectorSnapshot.capabilitySnapshotHash,
      renderedPayloadFingerprint: asanaArtifact.renderedPayloadFingerprint,
    };
    const sink = new GuardedProviderExecutionSink({
      persistence,
      claim: () => claim,
      envelope: () => createEnvelope,
      connectors: {
        communication: () => ({}) as CommunicationConnector,
        workManagement: () => workConnector,
      },
      now: () => RUN_AT,
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: 30_000,
    });

    const accepted = await sink.dispatch(asanaArtifact);
    expect(accepted).toMatchObject({
      outcome: 'accepted',
    });
    if (accepted.outcome !== 'accepted') {
      throw new Error('EXPECTED_ASANA_ACCEPTANCE');
    }
    await persistence.settleAcceptedWorkManagementEffect({
      claim,
      artifact: asanaArtifact,
      result: accepted,
    });
    expect(persistence.workManagementLinks).toEqual(['asana-task-12001']);

    for (const operation of ['update_task', 'create_comment'] as const) {
      const denied = new GuardedProviderExecutionSink({
        persistence,
        claim: () => claim,
        envelope: () => ({ ...createEnvelope, operation }),
        connectors: {
          communication: () => ({}) as CommunicationConnector,
          workManagement: () => workConnector,
        },
        now: () => RUN_AT,
        heartbeatIntervalMs: 5_000,
        leaseDurationMs: 30_000,
      });
      await expect(denied.dispatch(asanaArtifact)).rejects.toThrow(
        'WORK_MANAGEMENT_EFFECT_CAPABILITY_DISABLED',
      );
    }
    expect(workConnector.execute).toHaveBeenCalledTimes(1);
  });
});

describe('SQS partial batches', () => {
  it.each([
    ['pre_dispatch_denied', 0],
    ['pre_dispatch_retryable', 1],
  ] as const)(
    'maps %s to the correct permanent/retryable batch disposition',
    async (status, failureCount) => {
      const execute = vi.fn(() =>
        Promise.resolve({ status, reasonCode: 'test_pre_dispatch_outcome' }),
      );
      const handler = createSqsExecutionHandler(execute, {
        workerId: 'worker-a',
        now: () => RUN_AT,
        defaultLeaseDurationMs: 30_000,
      });
      const result = await handler({
        Records: [
          {
            messageId: 'message-pre-dispatch',
            body: JSON.stringify({ operationId: 'operation-send-001' }),
          },
        ],
      });
      expect(result.batchItemFailures).toHaveLength(failureCount);
    },
  );

  it('isolates a poison item and processes the remainder', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'duplicate' });
    const handler = createSqsExecutionHandler(execute, {
      workerId: 'worker-a',
      now: () => RUN_AT,
      defaultLeaseDurationMs: 30_000,
    });
    await expect(
      handler({
        Records: [
          { messageId: 'valid-1', body: '{"operationId":"operation-1"}' },
          { messageId: 'poison-2', body: '{not-json' },
          { messageId: 'valid-3', body: '{"operationId":"operation-3"}' },
        ],
      }),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'poison-2' }],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects tenant/account/provider authority smuggled in a queue message', async () => {
    const execute = vi.fn();
    const handler = createSqsExecutionHandler(execute, {
      workerId: 'worker-a',
      now: () => RUN_AT,
      defaultLeaseDurationMs: 30_000,
    });
    await expect(
      handler({
        Records: [
          {
            messageId: 'attack-1',
            body: JSON.stringify({
              operationId: 'operation-1',
              tenantId: 'tenant-attacker',
              accountId: 'account-victim',
            }),
          },
        ],
      }),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'attack-1' }],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

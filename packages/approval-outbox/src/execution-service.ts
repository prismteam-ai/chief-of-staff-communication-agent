import type {
  ActionPlan,
  Approval,
  ContactChannelPolicy,
  EffectExecutionArtifact,
  ProviderSendResult,
} from '@chief/contracts/approval';
import type { ConnectorSnapshot } from '@chief/contracts/connectors';
import type { OperationId } from '@chief/contracts/ids';
import {
  assertApprovalAuthorizes,
  assertContactEligible,
  assertOrdinaryRetryAllowed,
} from '@chief/domain';

import {
  assertExactActionPlanHash,
  canonicalSha256,
  immutable,
} from './canonical.js';
import type {
  EffectSwitchBinding,
  ImmutableOperationRecord,
} from './approval-service.js';

export type ExecutionBoundary =
  | 'after_claim'
  | 'after_guard'
  | 'after_attempt_persisted'
  | 'after_sink'
  | 'after_result_persisted';

export interface CurrentConnectorState {
  readonly accountId: string;
  readonly stateVersion: number;
  readonly status: 'pending' | 'active' | 'degraded' | 'revoked' | 'disabled';
  readonly health: 'unknown' | 'healthy' | 'degraded' | 'failed';
  readonly snapshot: ConnectorSnapshot;
  readonly operationCapabilityEnabled: boolean;
}

export interface CurrentEffectSwitchState extends EffectSwitchBinding {
  readonly globalEnabled: boolean;
  readonly accountEnabled: boolean;
  readonly operationEnabled: boolean;
}

export interface AuthoritativeExecutionState {
  readonly actionPlan: ActionPlan;
  readonly approval: Approval;
  readonly operation: ImmutableOperationRecord;
  readonly currentSourceMessageRevisionId: string;
  readonly approverAuthorityActive: boolean;
  readonly connector: CurrentConnectorState;
  readonly contactPolicies: readonly ContactChannelPolicy[];
  readonly effectSwitch: CurrentEffectSwitchState;
}

export interface OperationClaim {
  readonly operationId: OperationId;
  readonly claimOwner: string;
  readonly claimEpoch: number;
  readonly leaseExpiresAt: string;
}

export type OperationClaimResult =
  | { readonly status: 'claimed'; readonly claim: OperationClaim }
  | { readonly status: 'duplicate' | 'contended' | 'frozen' };

export interface ApprovalExecutionPersistence {
  claimOperation(input: {
    readonly operationId: OperationId;
    readonly claimOwner: string;
    readonly now: string;
    readonly leaseDurationMs: number;
  }): Promise<OperationClaimResult>;
  loadAuthoritativeState(
    operationId: OperationId,
  ): Promise<AuthoritativeExecutionState | undefined>;
  releaseUncalledClaim(claim: OperationClaim): Promise<void>;
  persistDispatchAttempt(
    claim: OperationClaim,
    artifact: EffectExecutionArtifact,
  ): Promise<void>;
  settleEffectDisabled(
    claim: OperationClaim,
    receipt: EffectDisabledReceipt,
  ): Promise<void>;
  settleRejected(
    claim: OperationClaim,
    result: Extract<ProviderSendResult, { readonly outcome: 'rejected' }>,
  ): Promise<void>;
  settleAcceptedAndCorrelation(
    claim: OperationClaim,
    result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ): Promise<void>;
  freezeAcceptanceUnknown(
    claim: OperationClaim,
    reasonCode: string,
    result?: Extract<
      ProviderSendResult,
      { readonly outcome: 'acceptance_unknown' }
    >,
  ): Promise<void>;
}

export interface EffectDisabledReceipt {
  readonly kind: 'effect_disabled';
  readonly operationId: OperationId;
  readonly artifactHash: string;
  readonly stableIdempotencyKey: string;
  readonly observedAt: string;
}

export type ExecutionSinkResult = EffectDisabledReceipt | ProviderSendResult;

export interface ExecutionSink {
  readonly mode: 'effect_disabled' | 'provider_fake';
  dispatch(artifact: EffectExecutionArtifact): Promise<ExecutionSinkResult>;
}

export interface ExecuteOperationInput {
  readonly operationId: OperationId;
  readonly workerId: string;
  readonly observedAt: string;
  readonly leaseDurationMs: number;
  readonly onBoundary?: (boundary: ExecutionBoundary) => void;
}

export type ExecuteOperationResult =
  | { readonly status: 'duplicate' | 'contended' | 'frozen' }
  | {
      readonly status: 'effect_disabled';
      readonly receipt: EffectDisabledReceipt;
    }
  | {
      readonly status: 'provider_rejected' | 'provider_accepted';
      readonly providerResult: ProviderSendResult;
    }
  | {
      readonly status: 'reconciliation_required';
      readonly providerResult?: ProviderSendResult;
    };

function sameSnapshot(
  left: ConnectorSnapshot,
  right: ConnectorSnapshot,
): boolean {
  return (
    left.connectorId === right.connectorId &&
    left.descriptorVersion === right.descriptorVersion &&
    left.accountId === right.accountId &&
    left.capabilitySnapshotHash === right.capabilitySnapshotHash &&
    left.runtimeMode === right.runtimeMode &&
    left.selectionState === right.selectionState
  );
}

function assertArtifactStillCurrent(state: AuthoritativeExecutionState): void {
  const { actionPlan, approval, operation } = state;
  const artifact = operation.artifact;
  assertExactActionPlanHash(actionPlan);
  assertApprovalAuthorizes({
    actorTenantId: actionPlan.tenantId,
    approval,
    actionPlan,
    observedAt: artifact.createdAt,
  });
  if (!state.approverAuthorityActive)
    throw new Error('APPROVER_AUTHORITY_REVOKED');
  if (
    artifact.actionPlanId !== actionPlan.actionPlanId ||
    artifact.actionPlanHash !== actionPlan.canonicalHash ||
    artifact.approvalId !== approval.approvalId ||
    artifact.sourceMessageRevisionId !== actionPlan.sourceMessageRevisionId ||
    artifact.operationId !== operation.outboxItem.operationId ||
    artifact.stableIdempotencyKey !==
      operation.outboxItem.stableIdempotencyKey ||
    canonicalSha256(artifact) !== operation.artifactHash
  ) {
    throw new Error('IMMUTABLE_EFFECT_ARTIFACT_MISMATCH');
  }
  if (
    state.currentSourceMessageRevisionId !== actionPlan.sourceMessageRevisionId
  ) {
    throw new Error('THREAD_REVISION_STALE');
  }
  const connector = state.connector;
  if (
    connector.accountId !== artifact.account.accountId ||
    connector.stateVersion !== artifact.account.expectedStateVersion ||
    connector.status !== 'active' ||
    connector.health !== 'healthy' ||
    !sameSnapshot(connector.snapshot, artifact.connectorSnapshot)
  ) {
    throw new Error('CONNECTOR_ACCOUNT_STALE_OR_UNHEALTHY');
  }
  if (!connector.operationCapabilityEnabled) {
    throw new Error('CONNECTOR_CAPABILITY_SUPPRESSED');
  }
  for (const approved of operation.binding.contactPolicies) {
    const current = state.contactPolicies.find(
      (policy) =>
        policy.tenantId === approved.tenantId &&
        policy.contactIdentityDigest === approved.contactIdentityDigest &&
        policy.channel === approved.channel &&
        policy.connectorAccountId === approved.connectorAccountId &&
        policy.brandId === approved.brandId,
    );
    if (current === undefined) throw new Error('CONTACT_POLICY_UNKNOWN');
    assertContactEligible(current, approved.projectionVersion);
  }
  const approvedSwitch = operation.binding.effectSwitch;
  const currentSwitch = state.effectSwitch;
  if (
    approvedSwitch.globalVersion !== currentSwitch.globalVersion ||
    approvedSwitch.accountVersion !== currentSwitch.accountVersion ||
    approvedSwitch.operationVersion !== currentSwitch.operationVersion ||
    approvedSwitch.policy !== currentSwitch.policy
  ) {
    throw new Error('EFFECT_SWITCH_VERSION_CHANGED');
  }
}

function assertSinkAllowed(
  state: AuthoritativeExecutionState,
  sink: ExecutionSink,
): void {
  const effectSwitch = state.effectSwitch;
  if (sink.mode === 'effect_disabled') {
    if (
      effectSwitch.policy !== 'effect_disabled' ||
      effectSwitch.globalEnabled ||
      effectSwitch.accountEnabled ||
      effectSwitch.operationEnabled
    ) {
      throw new Error('EFFECT_DISABLED_SINK_POLICY_MISMATCH');
    }
    return;
  }
  if (
    effectSwitch.policy !== 'external_effect' ||
    !effectSwitch.globalEnabled ||
    !effectSwitch.accountEnabled ||
    !effectSwitch.operationEnabled ||
    state.connector.snapshot.selectionState !== 'selected' ||
    state.connector.snapshot.runtimeMode === 'fixture' ||
    state.connector.snapshot.runtimeMode === 'manual' ||
    state.connector.snapshot.runtimeMode === 'blocked_external_access' ||
    state.connector.snapshot.runtimeMode === 'disabled'
  ) {
    throw new Error('EXTERNAL_EFFECTS_DISABLED');
  }
}

async function releaseOnGuardFailure(
  persistence: ApprovalExecutionPersistence,
  claim: OperationClaim,
  action: () => void,
): Promise<void> {
  try {
    action();
  } catch (error) {
    await persistence.releaseUncalledClaim(claim);
    throw error;
  }
}

export async function executeApprovedOperation(
  persistence: ApprovalExecutionPersistence,
  sink: ExecutionSink,
  input: ExecuteOperationInput,
): Promise<ExecuteOperationResult> {
  const claimResult = await persistence.claimOperation({
    operationId: input.operationId,
    claimOwner: input.workerId,
    now: input.observedAt,
    leaseDurationMs: input.leaseDurationMs,
  });
  if (claimResult.status !== 'claimed') return { status: claimResult.status };
  const claim = claimResult.claim;
  input.onBoundary?.('after_claim');
  const state = await persistence.loadAuthoritativeState(input.operationId);
  if (state === undefined) {
    await persistence.releaseUncalledClaim(claim);
    throw new Error('AUTHORITATIVE_EXECUTION_STATE_NOT_FOUND');
  }
  await releaseOnGuardFailure(persistence, claim, () => {
    if (Date.parse(input.observedAt) >= Date.parse(state.approval.expiresAt)) {
      throw new Error('APPROVAL_EXPIRED');
    }
    assertArtifactStillCurrent(state);
    assertApprovalAuthorizes({
      actorTenantId: state.actionPlan.tenantId,
      approval: state.approval,
      actionPlan: state.actionPlan,
      observedAt: input.observedAt,
    });
    assertSinkAllowed(state, sink);
  });
  input.onBoundary?.('after_guard');
  await persistence.persistDispatchAttempt(claim, state.operation.artifact);
  input.onBoundary?.('after_attempt_persisted');

  let result: ExecutionSinkResult;
  try {
    result = await sink.dispatch(state.operation.artifact);
  } catch {
    await persistence.freezeAcceptanceUnknown(claim, 'sink_call_threw');
    return { status: 'reconciliation_required' };
  }
  input.onBoundary?.('after_sink');

  if ('kind' in result) {
    await persistence.settleEffectDisabled(claim, result);
    input.onBoundary?.('after_result_persisted');
    return { status: 'effect_disabled', receipt: result };
  }
  if (result.outcome === 'acceptance_unknown') {
    await persistence.freezeAcceptanceUnknown(claim, result.reasonCode, result);
    input.onBoundary?.('after_result_persisted');
    return { status: 'reconciliation_required', providerResult: result };
  }
  if (result.outcome === 'rejected') {
    await persistence.settleRejected(claim, result);
    input.onBoundary?.('after_result_persisted');
    return { status: 'provider_rejected', providerResult: result };
  }
  try {
    await persistence.settleAcceptedAndCorrelation(claim, result);
  } catch {
    await persistence.freezeAcceptanceUnknown(
      claim,
      'correlation_persistence_failed',
      {
        outcome: 'acceptance_unknown',
        providerResponseHash: result.providerResponseHash,
        reasonCode: 'correlation_persistence_failed',
        observedAt: result.observedAt,
      },
    );
    return {
      status: 'reconciliation_required',
      providerResult: {
        outcome: 'acceptance_unknown',
        providerResponseHash: result.providerResponseHash,
        reasonCode: 'correlation_persistence_failed',
        observedAt: result.observedAt,
      },
    };
  }
  input.onBoundary?.('after_result_persisted');
  return { status: 'provider_accepted', providerResult: result };
}

export class EffectDisabledSink implements ExecutionSink {
  public readonly mode = 'effect_disabled' as const;

  public constructor(private readonly now: () => string) {}

  public dispatch(
    artifact: EffectExecutionArtifact,
  ): Promise<EffectDisabledReceipt> {
    return Promise.resolve(
      immutable({
        kind: 'effect_disabled' as const,
        operationId: artifact.operationId,
        artifactHash: canonicalSha256(artifact),
        stableIdempotencyKey: artifact.stableIdempotencyKey,
        observedAt: this.now(),
      }),
    );
  }
}

export type ReconciliationEvidence =
  | { readonly result: 'proven_accepted'; readonly providerCorrelation: string }
  | { readonly result: 'proven_not_accepted' }
  | { readonly result: 'unresolved' };

export function decideReconciliation(
  evidence: ReconciliationEvidence,
): 'settle_accepted' | 'retry_identical_operation' | 'remain_frozen' {
  if (evidence.result === 'proven_accepted') return 'settle_accepted';
  if (evidence.result === 'proven_not_accepted') {
    return 'retry_identical_operation';
  }
  return 'remain_frozen';
}

export function assertIdenticalOperationRetry(input: {
  readonly priorArtifact: EffectExecutionArtifact;
  readonly retryArtifact: EffectExecutionArtifact;
  readonly priorAttempt: Parameters<typeof assertOrdinaryRetryAllowed>[0];
}): void {
  assertOrdinaryRetryAllowed(input.priorAttempt);
  const prior = {
    ...input.priorArtifact,
    attemptId: '<attempt-id>',
    createdAt: '<attempt-created-at>',
  };
  const retry = {
    ...input.retryArtifact,
    attemptId: '<attempt-id>',
    createdAt: '<attempt-created-at>',
  };
  if (
    input.priorArtifact.attemptId === input.retryArtifact.attemptId ||
    canonicalSha256(prior) !== canonicalSha256(retry)
  ) {
    throw new Error('RETRY_MUST_PRESERVE_IDENTICAL_OPERATION');
  }
}

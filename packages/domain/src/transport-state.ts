import type {
  ActionPlan,
  Approval,
  EffectExecutionArtifact,
  RiskAcknowledgement,
  SendAttempt,
  TenantId,
  TransportState,
} from '@chief/contracts';

import { assertApprovalAuthorizes } from './approval-lifecycle.js';
import { assertTenant, DomainInvariantError, immutable } from './invariants.js';

const transitions: Readonly<Record<TransportState, readonly TransportState[]>> =
  {
    queued: ['provider_rejected', 'provider_accepted', 'acceptance_unknown'],
    provider_rejected: [],
    provider_accepted: ['delivered', 'delivery_failed', 'bounced'],
    delivered: [],
    delivery_failed: ['delivered', 'bounced'],
    bounced: [],
    acceptance_unknown: [],
  };

const transportRank: Readonly<Record<TransportState, number>> = {
  queued: 0,
  provider_rejected: 1,
  provider_accepted: 1,
  delivery_failed: 2,
  delivered: 3,
  bounced: 3,
  acceptance_unknown: 0,
};

export function applyTransportFact(input: {
  readonly actorTenantId: TenantId;
  readonly attempt: SendAttempt;
  readonly nextState: TransportState;
  readonly providerCorrelationDigest?: SendAttempt['providerCorrelationDigest'];
}): Readonly<SendAttempt> {
  assertTenant(input.actorTenantId, input.attempt.tenantId);
  if (input.nextState === input.attempt.transportState) {
    return input.attempt;
  }
  if (
    input.attempt.transportState !== 'acceptance_unknown' &&
    transportRank[input.nextState] < transportRank[input.attempt.transportState]
  ) {
    return input.attempt;
  }
  if (!transitions[input.attempt.transportState].includes(input.nextState)) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      `transport cannot transition from ${input.attempt.transportState} to ${input.nextState}`,
    );
  }
  if (
    input.nextState === 'provider_accepted' &&
    input.providerCorrelationDigest === undefined
  ) {
    throw new DomainInvariantError(
      'CORRELATION_REQUIRED',
      'provider correlation must persist before provider acceptance',
    );
  }
  return immutable({
    ...input.attempt,
    transportState: input.nextState,
    stateVersion: input.attempt.stateVersion + 1,
    ...(input.providerCorrelationDigest === undefined
      ? {}
      : { providerCorrelationDigest: input.providerCorrelationDigest }),
    lifecycleState:
      input.nextState === 'acceptance_unknown'
        ? 'reconciliation_required'
        : input.nextState === 'provider_accepted'
          ? 'settled'
          : input.attempt.lifecycleState,
    retryDecision:
      input.nextState === 'provider_rejected'
        ? 'retry_allowed'
        : input.nextState === 'acceptance_unknown'
          ? 'retry_denied'
          : input.attempt.retryDecision,
  });
}

export function reconcileAcceptanceUnknown(input: {
  readonly actorTenantId: TenantId;
  readonly attempt: SendAttempt;
  readonly resolution: 'proven_accepted' | 'proven_not_accepted' | 'unresolved';
  readonly providerCorrelationDigest?: SendAttempt['providerCorrelationDigest'];
}): Readonly<SendAttempt> {
  assertTenant(input.actorTenantId, input.attempt.tenantId);
  if (input.attempt.transportState !== 'acceptance_unknown') {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'only acceptance-unknown attempts enter reconciliation',
    );
  }
  if (input.resolution === 'unresolved') {
    return input.attempt;
  }
  if (
    input.resolution === 'proven_accepted' &&
    input.providerCorrelationDigest === undefined
  ) {
    throw new DomainInvariantError(
      'CORRELATION_REQUIRED',
      'reconciled provider acceptance requires provider correlation',
    );
  }
  return immutable({
    ...input.attempt,
    transportState:
      input.resolution === 'proven_accepted'
        ? 'provider_accepted'
        : 'provider_rejected',
    lifecycleState: 'reconciled',
    retryDecision:
      input.resolution === 'proven_not_accepted'
        ? 'retry_allowed'
        : 'retry_denied',
    stateVersion: input.attempt.stateVersion + 1,
    ...(input.providerCorrelationDigest === undefined
      ? {}
      : { providerCorrelationDigest: input.providerCorrelationDigest }),
  });
}

export function assertEffectNotDuplicated(
  artifact: EffectExecutionArtifact,
  attempts: readonly SendAttempt[],
): void {
  for (const attempt of attempts) {
    assertTenant(artifact.tenantId, attempt.tenantId);
  }
  const duplicate = attempts.find(
    (attempt) =>
      attempt.operationId === artifact.operationId &&
      (attempt.lifecycleState === 'dispatching' ||
        attempt.transportState === 'provider_accepted' ||
        attempt.transportState === 'delivered' ||
        attempt.transportState === 'acceptance_unknown'),
  );
  if (duplicate !== undefined) {
    throw new DomainInvariantError(
      'DUPLICATE_EFFECT',
      'operation already dispatched or requires reconciliation',
    );
  }
}

export function assertOrdinaryRetryAllowed(attempt: SendAttempt): void {
  if (
    attempt.transportState !== 'provider_rejected' ||
    attempt.retryDecision !== 'retry_allowed'
  ) {
    throw new DomainInvariantError(
      'UNSAFE_RETRY',
      'ordinary retry requires proven provider non-acceptance',
    );
  }
}

export function assertRiskAcknowledgedResend(input: {
  readonly actorTenantId: TenantId;
  readonly frozenAttempt: SendAttempt;
  readonly acknowledgement: RiskAcknowledgement;
  readonly newActionPlan: ActionPlan;
  readonly freshApproval: Approval;
  readonly observedAt: string;
}): void {
  assertTenant(input.actorTenantId, input.frozenAttempt.tenantId);
  assertTenant(input.actorTenantId, input.acknowledgement.tenantId);
  if (input.frozenAttempt.transportState !== 'acceptance_unknown') {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      'duplicate-risk acknowledgement applies only to acceptance-unknown effects',
    );
  }
  if (
    input.acknowledgement.frozenOperationId !==
      input.frozenAttempt.operationId ||
    input.acknowledgement.newActionPlanId !== input.newActionPlan.actionPlanId
  ) {
    throw new DomainInvariantError(
      'APPROVAL_INVALID',
      'risk acknowledgement does not bind the frozen effect and new action plan',
    );
  }
  if (
    input.newActionPlan.operations.some(
      (operation) => operation.operationId === input.frozenAttempt.operationId,
    )
  ) {
    throw new DomainInvariantError(
      'UNSAFE_RETRY',
      'a resend after unknown acceptance must use a new operation identifier',
    );
  }
  assertApprovalAuthorizes({
    actorTenantId: input.actorTenantId,
    approval: input.freshApproval,
    actionPlan: input.newActionPlan,
    observedAt: input.observedAt,
  });
}

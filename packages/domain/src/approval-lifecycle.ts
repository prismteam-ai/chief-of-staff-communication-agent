import type { ActionPlan, Approval, TenantId } from '@chief/contracts';

import {
  assertExpected,
  assertTenant,
  DomainInvariantError,
  immutable,
  instantMilliseconds,
} from './invariants.js';

const transitions: Readonly<
  Record<Approval['status'], readonly Approval['status'][]>
> = {
  active: ['consumed', 'revoked', 'expired', 'invalidated'],
  consumed: [],
  revoked: [],
  expired: [],
  invalidated: [],
};

export function assertApprovalAuthorizes(input: {
  readonly actorTenantId: TenantId;
  readonly approval: Approval;
  readonly actionPlan: ActionPlan;
  readonly observedAt: string;
}): void {
  assertTenant(input.actorTenantId, input.approval.tenantId);
  assertTenant(input.approval.tenantId, input.actionPlan.tenantId);
  if (input.approval.status !== 'active') {
    throw new DomainInvariantError(
      'APPROVAL_INVALID',
      `approval is ${input.approval.status}`,
    );
  }
  if (
    instantMilliseconds(input.approval.expiresAt) <=
      instantMilliseconds(input.observedAt) ||
    instantMilliseconds(input.actionPlan.expiresAt) <=
      instantMilliseconds(input.observedAt)
  ) {
    throw new DomainInvariantError('APPROVAL_INVALID', 'approval has expired');
  }
  if (
    input.approval.actionPlanId !== input.actionPlan.actionPlanId ||
    input.approval.actionPlanRevision !== input.actionPlan.revision ||
    input.approval.actionPlanHash !== input.actionPlan.canonicalHash ||
    input.approval.sourceMessageRevisionId !==
      input.actionPlan.sourceMessageRevisionId ||
    input.approval.policyVersion !== input.actionPlan.policyVersion
  ) {
    throw new DomainInvariantError(
      'APPROVAL_INVALID',
      'approval does not bind this exact action-plan revision',
    );
  }
}

export function transitionApproval(input: {
  readonly actorTenantId: TenantId;
  readonly approval: Approval;
  readonly expectedStateVersion: number;
  readonly nextStatus: Approval['status'];
  readonly reason?: string;
}): Readonly<Approval> {
  assertTenant(input.actorTenantId, input.approval.tenantId);
  assertExpected(
    input.approval.stateVersion,
    input.expectedStateVersion,
    'revision',
  );
  if (!transitions[input.approval.status].includes(input.nextStatus)) {
    throw new DomainInvariantError(
      'INVALID_TRANSITION',
      `approval cannot transition from ${input.approval.status} to ${input.nextStatus}`,
    );
  }
  return immutable({
    ...input.approval,
    status: input.nextStatus,
    stateVersion: input.approval.stateVersion + 1,
    ...(input.reason === undefined ? {} : { invalidationReason: input.reason }),
  });
}

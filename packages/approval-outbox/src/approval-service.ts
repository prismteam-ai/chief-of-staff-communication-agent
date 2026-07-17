import {
  approvalSchema,
  effectExecutionArtifactSchema,
  executionIntentSchema,
  outboxItemSchema,
  riskAcknowledgementSchema,
  type ActionPlan,
  type Approval,
  type ContactChannelPolicy,
  type EffectExecutionArtifact,
  type ExecutionIntent,
  type OutboxItem,
  type RiskAcknowledgement,
} from '@chief/contracts/approval';
import type {
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';
import type {
  AttemptId,
  DraftRevisionId,
  OperationId,
} from '@chief/contracts/ids';
import type { VerifiedActorContext } from '@chief/contracts/tenancy';
import {
  assertApprovalAuthorizes,
  assertRiskAcknowledgedResend,
} from '@chief/domain';

import {
  assertExactActionPlanHash,
  canonicalSha256,
  immutable,
} from './canonical.js';

export interface ContactPolicyBinding {
  readonly tenantId: ContactChannelPolicy['tenantId'];
  readonly contactIdentityDigest: ContactChannelPolicy['contactIdentityDigest'];
  readonly channel: ContactChannelPolicy['channel'];
  readonly connectorAccountId: ContactChannelPolicy['connectorAccountId'];
  readonly brandId: ContactChannelPolicy['brandId'];
  readonly projectionVersion: number;
}

export interface EffectSwitchBinding {
  readonly globalVersion: number;
  readonly accountVersion: number;
  readonly operationVersion: number;
  readonly policy: 'effect_disabled' | 'external_effect';
}

export interface OperationApprovalBinding {
  readonly operationId: OperationId;
  readonly attemptId: AttemptId;
  readonly account: ConnectorAccountRef;
  readonly connectorSnapshot: ConnectorSnapshot;
  readonly renderedPayloadFingerprint: string;
  readonly draftRevisionId?: DraftRevisionId;
  readonly clientCorrelation: EffectExecutionArtifact['clientCorrelation'];
  readonly correlationBindingVersion: string;
  readonly reconciliationStrategy: string;
  readonly reconciliationStrategyVersion: string;
  readonly contactPolicies: readonly ContactPolicyBinding[];
  readonly effectSwitch: EffectSwitchBinding;
}

export interface ImmutableOperationRecord {
  readonly outboxItem: OutboxItem;
  readonly artifact: EffectExecutionArtifact;
  readonly binding: OperationApprovalBinding;
  readonly artifactHash: string;
}

export interface ImmutableApprovalBundle {
  readonly actionPlan: ActionPlan;
  readonly approval: Approval;
  readonly executionIntent: ExecutionIntent;
  readonly operations: readonly ImmutableOperationRecord[];
}

export interface ApprovalOutboxPersistence {
  createImmutableBundle(
    bundle: ImmutableApprovalBundle,
  ): Promise<'created' | 'duplicate'>;
}

export interface ApproveActionPlanInput {
  readonly actor: VerifiedActorContext;
  readonly actionPlan: ActionPlan;
  readonly approvalId: string;
  readonly executionIntentId: string;
  readonly approvedAt: string;
  readonly bindings: readonly OperationApprovalBinding[];
  readonly requiredGrant?: string;
}

function stableIdempotencyKey(
  plan: ActionPlan,
  operationIndex: number,
): string {
  return canonicalSha256({
    tenantId: plan.tenantId,
    actionPlanId: plan.actionPlanId,
    operationIndex,
    operation: plan.operations[operationIndex],
  });
}

function assertBindingMatchesOperation(
  plan: ActionPlan,
  index: number,
  binding: OperationApprovalBinding,
  actor: VerifiedActorContext,
): void {
  const operation = plan.operations[index];
  if (
    operation === undefined ||
    operation.operationId !== binding.operationId
  ) {
    throw new Error('OPERATION_BINDING_MISMATCH');
  }
  const expectedFingerprint =
    operation.kind === 'send_message'
      ? operation.renderedPayloadFingerprint
      : operation.exactFieldsHash;
  if (expectedFingerprint !== binding.renderedPayloadFingerprint) {
    throw new Error('RENDERED_PAYLOAD_FINGERPRINT_MISMATCH');
  }
  if (
    binding.account.tenantId !== plan.tenantId ||
    binding.account.accountId !== operation.connectorAccountId ||
    binding.connectorSnapshot.accountId !== operation.connectorAccountId
  ) {
    throw new Error('OPERATION_ACCOUNT_BINDING_MISMATCH');
  }
  if (!actor.accountScopes.includes(operation.connectorAccountId)) {
    throw new Error('APPROVER_ACCOUNT_SCOPE_REQUIRED');
  }
  if (
    operation.kind === 'send_message' &&
    operation.draftRevisionId !== binding.draftRevisionId
  ) {
    throw new Error('DRAFT_REVISION_BINDING_MISMATCH');
  }
  if (operation.kind !== 'send_message') {
    if (binding.contactPolicies.length > 0) {
      throw new Error('WORK_MANAGEMENT_CONTACT_POLICY_NOT_ALLOWED');
    }
    return;
  }
  const recipientDigests = operation.recipientDigests;
  const approvedDigests = binding.contactPolicies.map(
    ({ contactIdentityDigest }) => contactIdentityDigest,
  );
  if (
    new Set(recipientDigests).size !== recipientDigests.length ||
    new Set(approvedDigests).size !== approvedDigests.length ||
    approvedDigests.length !== recipientDigests.length ||
    recipientDigests.some((digest) => !approvedDigests.includes(digest))
  ) {
    throw new Error('RECIPIENT_CONTACT_POLICY_BINDING_MISMATCH');
  }
  for (const policy of binding.contactPolicies) {
    if (
      policy.tenantId !== plan.tenantId ||
      policy.connectorAccountId !== operation.connectorAccountId ||
      !actor.brandScopes.includes(policy.brandId)
    ) {
      throw new Error('RECIPIENT_CONTACT_POLICY_SCOPE_MISMATCH');
    }
  }
}

export function buildImmutableApprovalBundle(
  input: ApproveActionPlanInput,
): ImmutableApprovalBundle {
  assertExactActionPlanHash(input.actionPlan);
  if (input.actor.tenantId !== input.actionPlan.tenantId) {
    throw new Error('APPROVER_TENANT_MISMATCH');
  }
  const requiredGrant = input.requiredGrant ?? 'actions:approve';
  if (!input.actor.grants.includes(requiredGrant)) {
    throw new Error('APPROVER_NOT_AUTHORIZED');
  }
  if (Date.parse(input.approvedAt) >= Date.parse(input.actionPlan.expiresAt)) {
    throw new Error('ACTION_PLAN_EXPIRED');
  }
  if (input.bindings.length !== input.actionPlan.operations.length) {
    throw new Error('OPERATION_BINDING_COUNT_MISMATCH');
  }

  const approval = approvalSchema.parse({
    schemaVersion: '1',
    tenantId: input.actionPlan.tenantId,
    approvalId: input.approvalId,
    actionPlanId: input.actionPlan.actionPlanId,
    actionPlanRevision: input.actionPlan.revision,
    actionPlanHash: input.actionPlan.canonicalHash,
    sourceMessageRevisionId: input.actionPlan.sourceMessageRevisionId,
    approverUserId: input.actor.userId,
    approvedAt: input.approvedAt,
    expiresAt: input.actionPlan.expiresAt,
    policyVersion: input.actionPlan.policyVersion,
    status: 'active',
    stateVersion: 1,
  });
  assertApprovalAuthorizes({
    actorTenantId: input.actor.tenantId,
    approval,
    actionPlan: input.actionPlan,
    observedAt: input.approvedAt,
  });

  const executionIntent = executionIntentSchema.parse({
    schemaVersion: '1',
    tenantId: input.actionPlan.tenantId,
    executionIntentId: input.executionIntentId,
    approvalId: approval.approvalId,
    actionPlanId: input.actionPlan.actionPlanId,
    actionPlanHash: input.actionPlan.canonicalHash,
    operationIds: input.actionPlan.operations.map(
      ({ operationId }) => operationId,
    ),
    status: 'ready',
    createdAt: input.approvedAt,
  });

  const operations = input.bindings.map((binding, index) => {
    assertBindingMatchesOperation(
      input.actionPlan,
      index,
      binding,
      input.actor,
    );
    const operation = input.actionPlan.operations[index];
    if (operation === undefined) throw new Error('OPERATION_BINDING_MISMATCH');
    const idempotencyKey = stableIdempotencyKey(input.actionPlan, index);
    const artifact = effectExecutionArtifactSchema.parse({
      schemaVersion: '1',
      tenantId: input.actionPlan.tenantId,
      operationId: operation.operationId,
      attemptId: binding.attemptId,
      stableIdempotencyKey: idempotencyKey,
      account: binding.account,
      sourceMessageRevisionId: input.actionPlan.sourceMessageRevisionId,
      actionPlanId: input.actionPlan.actionPlanId,
      actionPlanHash: input.actionPlan.canonicalHash,
      approvalId: approval.approvalId,
      ...(binding.draftRevisionId === undefined
        ? {}
        : { draftRevisionId: binding.draftRevisionId }),
      renderedPayloadFingerprint: binding.renderedPayloadFingerprint,
      connectorSnapshot: binding.connectorSnapshot,
      clientCorrelation: binding.clientCorrelation,
      correlationBindingVersion: binding.correlationBindingVersion,
      reconciliationStrategy: binding.reconciliationStrategy,
      reconciliationStrategyVersion: binding.reconciliationStrategyVersion,
      createdAt: input.approvedAt,
    });
    const outboxItem = outboxItemSchema.parse({
      schemaVersion: '1',
      tenantId: input.actionPlan.tenantId,
      outboxItemId: `outbox_${idempotencyKey}`,
      operationId: operation.operationId,
      stableIdempotencyKey: idempotencyKey,
      approvalId: approval.approvalId,
      actionPlanId: input.actionPlan.actionPlanId,
      status: 'ready',
      attemptCount: 0,
      stateVersion: 1,
    });
    return immutable({
      outboxItem,
      artifact,
      binding,
      artifactHash: canonicalSha256(artifact),
    });
  });

  return immutable({
    actionPlan: input.actionPlan,
    approval,
    executionIntent,
    operations,
  });
}

export async function approveActionPlan(
  persistence: ApprovalOutboxPersistence,
  input: ApproveActionPlanInput,
): Promise<ImmutableApprovalBundle> {
  const bundle = buildImmutableApprovalBundle(input);
  const result = await persistence.createImmutableBundle(bundle);
  if (result === 'duplicate') throw new Error('APPROVAL_BUNDLE_ALREADY_EXISTS');
  return bundle;
}

export function assertFreshRiskAcknowledgedResend(input: {
  readonly actorTenantId: ActionPlan['tenantId'];
  readonly frozenAttempt: Parameters<
    typeof assertRiskAcknowledgedResend
  >[0]['frozenAttempt'];
  readonly acknowledgement: RiskAcknowledgement;
  readonly newActionPlan: ActionPlan;
  readonly freshApproval: Approval;
  readonly observedAt: string;
}): void {
  assertExactActionPlanHash(input.newActionPlan);
  const acknowledgement = riskAcknowledgementSchema.parse(
    input.acknowledgement,
  );
  if (
    acknowledgement.acknowledgedBy !== input.freshApproval.approverUserId ||
    Date.parse(acknowledgement.acknowledgedAt) >
      Date.parse(input.freshApproval.approvedAt) ||
    Date.parse(acknowledgement.acknowledgedAt) > Date.parse(input.observedAt)
  ) {
    throw new Error('AUTHENTICATED_RISK_ACKNOWLEDGEMENT_REQUIRED');
  }
  assertRiskAcknowledgedResend({
    ...input,
    acknowledgement,
  });
}

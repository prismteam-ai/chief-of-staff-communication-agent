import {
  actionPlanSchema,
  riskAcknowledgementSchema,
  sendAttemptSchema,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
} from '@chief/contracts/connectors';
import {
  brandIdSchema,
  keyedDigestValueSchema,
  tenantIdSchema,
} from '@chief/contracts/ids';
import { verifiedActorContextSchema } from '@chief/contracts/tenancy';
import { describe, expect, it, vi } from 'vitest';

import {
  approveActionPlan,
  assertFreshRiskAcknowledgedResend,
  buildImmutableApprovalBundle,
  type ApproveActionPlanInput,
  type ApprovalOutboxPersistence,
  type ImmutableApprovalBundle,
  type OperationApprovalBinding,
} from './approval-service.js';
import {
  assertExactActionPlanHash,
  computeActionPlanHash,
} from './canonical.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST = `h1_v1_${'A'.repeat(43)}`;
const DIGEST_B = `h1_v1_${'B'.repeat(42)}A`;
const NOW = '2026-07-17T12:00:00.000Z';
const LATER = '2026-07-17T13:00:00.000Z';

function actionPlan(input?: {
  readonly operationId?: string;
  readonly planId?: string;
}) {
  const candidate = actionPlanSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    actionPlanId: input?.planId ?? 'plan-001',
    revision: 1,
    sourceMessageRevisionId: 'gmail-message-revision-44',
    operations: [
      {
        kind: 'send_message',
        operationId: input?.operationId ?? 'send-operation-001',
        connectorAccountId: 'gmail-executive-account',
        draftRevisionId: 'draft-revision-007',
        recipientDigests: [DIGEST],
        renderedPayloadFingerprint: HASH_A,
      },
    ],
    policyVersion: 'approval-policy-9',
    expiresAt: LATER,
    canonicalHash: HASH_B,
    createdAt: NOW,
  });
  return actionPlanSchema.parse({
    ...candidate,
    canonicalHash: computeActionPlanHash(candidate),
  });
}

function actor() {
  return verifiedActorContextSchema.parse({
    authoritySource: 'verified_identity',
    tenantId: 'tenant-redwood',
    userId: 'executive-ada',
    accountScopes: ['gmail-executive-account'],
    brandScopes: ['brand-redwood'],
    grants: ['actions:approve'],
    membershipVersion: 4,
    verifiedClaimsHash: HASH_B,
    verifiedAt: NOW,
  });
}

function binding(operationId = 'send-operation-001'): OperationApprovalBinding {
  return {
    operationId:
      actionPlanSchema.parse(actionPlan()).operations[0]!.operationId,
    attemptId: 'attempt-001' as OperationApprovalBinding['attemptId'],
    account: connectorAccountRefSchema.parse({
      tenantId: 'tenant-redwood',
      accountId: 'gmail-executive-account',
      expectedStateVersion: 12,
    }),
    connectorSnapshot: connectorSnapshotSchema.parse({
      connectorId: 'gmail',
      descriptorVersion: 'gmail-v1',
      accountId: 'gmail-executive-account',
      capabilitySnapshotHash: HASH_B,
      runtimeMode: 'fixture',
      selectionState: 'selected',
    }),
    renderedPayloadFingerprint: HASH_A,
    draftRevisionId:
      'draft-revision-007' as OperationApprovalBinding['draftRevisionId'],
    clientCorrelation: {
      kind: 'rfc_message_id',
      value: `<chief-${operationId}@example.test>`,
    },
    correlationBindingVersion: 'correlation-v1',
    reconciliationStrategy: 'rfc-message-id-query',
    reconciliationStrategyVersion: 'gmail-reconcile-v1',
    contactPolicies: [
      {
        tenantId: tenantIdSchema.parse('tenant-redwood'),
        contactIdentityDigest: keyedDigestValueSchema.parse(DIGEST),
        channel: 'email',
        connectorAccountId: connectorAccountRefSchema.parse({
          tenantId: 'tenant-redwood',
          accountId: 'gmail-executive-account',
          expectedStateVersion: 12,
        }).accountId,
        brandId: brandIdSchema.parse('brand-redwood'),
        projectionVersion: 7,
      },
    ],
    effectSwitch: {
      globalVersion: 3,
      accountVersion: 5,
      operationVersion: 1,
      policy: 'effect_disabled',
    },
  };
}

function build(plan = actionPlan()) {
  return buildImmutableApprovalBundle({
    actor: actor(),
    actionPlan: plan,
    approvalId: 'approval-001',
    executionIntentId: 'intent-001',
    approvedAt: '2026-07-17T12:05:00.000Z',
    bindings: [binding()],
  });
}

describe('immutable approval/outbox creation', () => {
  it('validates the exact canonical action-plan hash', () => {
    const plan = actionPlan();
    expect(() => assertExactActionPlanHash(plan)).not.toThrow();
    expect(() =>
      assertExactActionPlanHash(
        actionPlanSchema.parse({
          ...plan,
          operations: [
            { ...plan.operations[0], renderedPayloadFingerprint: HASH_B },
          ],
        }),
      ),
    ).toThrow('ACTION_PLAN_HASH_MISMATCH');
  });

  it('creates one immutable intent/outbox/artifact with a stable operation key', () => {
    const first = build();
    const second = build();

    expect(first.approval).toMatchObject({ status: 'active', stateVersion: 1 });
    expect(first.executionIntent).toMatchObject({
      status: 'ready',
      operationIds: ['send-operation-001'],
    });
    expect(first.operations[0]?.artifact.stableIdempotencyKey).toBe(
      second.operations[0]?.artifact.stableIdempotencyKey,
    );
    expect(first.operations[0]?.artifact).toMatchObject({
      approvalId: first.approval.approvalId,
      actionPlanHash: first.actionPlan.canonicalHash,
      renderedPayloadFingerprint: HASH_A,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operations[0]?.artifact)).toBe(true);
  });

  const invalidApprovals: ReadonlyArray<
    readonly [string, Partial<ApproveActionPlanInput>]
  > = [
    [
      'cross-tenant approver',
      {
        actor: verifiedActorContextSchema.parse({
          ...actor(),
          tenantId: 'tenant-other',
        }),
      },
    ],
    [
      'missing grant',
      { actor: verifiedActorContextSchema.parse({ ...actor(), grants: [] }) },
    ],
    [
      'out-of-scope operation account',
      {
        actor: verifiedActorContextSchema.parse({
          ...actor(),
          accountScopes: [],
        }),
      },
    ],
    ['expired plan', { approvedAt: LATER }],
  ];

  it.each(invalidApprovals)(
    'rejects %s before persistence',
    async (_label, override) => {
      const persistence: ApprovalOutboxPersistence = {
        createImmutableBundle: vi.fn().mockResolvedValue('created' as const),
      };
      await expect(
        approveActionPlan(persistence, {
          actor: actor(),
          actionPlan: actionPlan(),
          approvalId: 'approval-001',
          executionIntentId: 'intent-001',
          approvedAt: '2026-07-17T12:05:00.000Z',
          bindings: [binding()],
          ...override,
        }),
      ).rejects.toThrow();
      expect(persistence.createImmutableBundle).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'substituted recipient policy',
      [
        {
          ...binding().contactPolicies[0]!,
          contactIdentityDigest: keyedDigestValueSchema.parse(DIGEST_B),
        },
      ],
    ],
    ['omitted recipient policy', []],
    [
      'duplicate recipient policy',
      [binding().contactPolicies[0]!, binding().contactPolicies[0]!],
    ],
  ])('rejects %s before immutable creation', (_label, contactPolicies) => {
    expect(() =>
      buildImmutableApprovalBundle({
        actor: actor(),
        actionPlan: actionPlan(),
        approvalId: 'approval-invalid-recipient-binding',
        executionIntentId: 'intent-invalid-recipient-binding',
        approvedAt: '2026-07-17T12:05:00.000Z',
        bindings: [{ ...binding(), contactPolicies }],
      }),
    ).toThrow('RECIPIENT_CONTACT_POLICY_BINDING_MISMATCH');
  });

  it('persists the entire immutable bundle through one transaction port call', async () => {
    let stored: ImmutableApprovalBundle | undefined;
    let calls = 0;
    const persistence: ApprovalOutboxPersistence = {
      createImmutableBundle: (bundle) => {
        calls += 1;
        stored = bundle;
        return Promise.resolve('created');
      },
    };
    const result = await approveActionPlan(persistence, {
      actor: actor(),
      actionPlan: actionPlan(),
      approvalId: 'approval-001',
      executionIntentId: 'intent-001',
      approvedAt: '2026-07-17T12:05:00.000Z',
      bindings: [binding()],
    });
    expect(calls).toBe(1);
    expect(stored).toBe(result);
  });

  it('requires a new operation and fresh approval for risk-acknowledged resend', () => {
    const original = build();
    const frozenAttempt = sendAttemptSchema.parse({
      schemaVersion: '1',
      tenantId: 'tenant-redwood',
      operationId: 'send-operation-001',
      attemptId: 'attempt-001',
      artifactHash: original.operations[0]!.artifactHash,
      stableIdempotencyKey:
        original.operations[0]!.artifact.stableIdempotencyKey,
      lifecycleState: 'reconciliation_required',
      transportState: 'acceptance_unknown',
      clientCorrelation: original.operations[0]!.artifact.clientCorrelation,
      correlationBindingVersion: 'correlation-v1',
      retryDecision: 'retry_denied',
      attemptedAt: NOW,
      stateVersion: 2,
    });
    const resendPlan = actionPlan({
      operationId: 'send-operation-resend-002',
      planId: 'plan-resend-002',
    });
    const resend = buildImmutableApprovalBundle({
      actor: actor(),
      actionPlan: resendPlan,
      approvalId: 'approval-resend-002',
      executionIntentId: 'intent-resend-002',
      approvedAt: '2026-07-17T12:10:00.000Z',
      bindings: [
        {
          ...binding('send-operation-resend-002'),
          operationId: resendPlan.operations[0]!.operationId,
          attemptId:
            'attempt-resend-002' as OperationApprovalBinding['attemptId'],
        },
      ],
    });
    const acknowledgement = riskAcknowledgementSchema.parse({
      schemaVersion: '1',
      tenantId: 'tenant-redwood',
      frozenOperationId: 'send-operation-001',
      newActionPlanId: resendPlan.actionPlanId,
      acknowledgedBy: 'executive-ada',
      risk: 'provider_may_have_already_accepted',
      acknowledgedAt: '2026-07-17T12:09:00.000Z',
    });

    expect(() =>
      assertFreshRiskAcknowledgedResend({
        actorTenantId: original.actionPlan.tenantId,
        frozenAttempt,
        acknowledgement,
        newActionPlan: resendPlan,
        freshApproval: resend.approval,
        observedAt: '2026-07-17T12:11:00.000Z',
      }),
    ).not.toThrow();
    expect(() =>
      assertFreshRiskAcknowledgedResend({
        actorTenantId: original.actionPlan.tenantId,
        frozenAttempt,
        acknowledgement,
        newActionPlan: original.actionPlan,
        freshApproval: original.approval,
        observedAt: '2026-07-17T12:11:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      assertFreshRiskAcknowledgedResend({
        actorTenantId: original.actionPlan.tenantId,
        frozenAttempt,
        acknowledgement: riskAcknowledgementSchema.parse({
          ...acknowledgement,
          acknowledgedBy: 'delegate-without-the-approval',
        }),
        newActionPlan: resendPlan,
        freshApproval: resend.approval,
        observedAt: '2026-07-17T12:11:00.000Z',
      }),
    ).toThrow('AUTHENTICATED_RISK_ACKNOWLEDGEMENT_REQUIRED');
  });
});

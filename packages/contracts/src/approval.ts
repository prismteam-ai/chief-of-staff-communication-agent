import { z } from 'zod';

import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
} from './connectors.js';
import {
  actionPlanIdSchema,
  accountIdSchema,
  approvalIdSchema,
  attemptIdSchema,
  brandIdSchema,
  draftRevisionIdSchema,
  eventIdSchema,
  executionIntentIdSchema,
  keyedDigestValueSchema,
  messageRevisionIdSchema,
  operationIdSchema,
  outboxItemIdSchema,
  sha256Schema,
  tenantIdSchema,
  timestampSchema,
  userIdSchema,
  versionSchema,
} from './ids.js';

export const transportStateSchema = z.enum([
  'queued',
  'provider_rejected',
  'provider_accepted',
  'delivered',
  'delivery_failed',
  'bounced',
  'acceptance_unknown',
]);

export const communicationEffectSchema = z
  .object({
    kind: z.literal('send_message'),
    operationId: operationIdSchema,
    connectorAccountId: accountIdSchema,
    draftRevisionId: draftRevisionIdSchema,
    recipientDigests: z.array(keyedDigestValueSchema).min(1),
    renderedPayloadFingerprint: sha256Schema,
  })
  .strict();

export const workManagementEffectSchema = z
  .object({
    kind: z.enum(['create_task', 'update_task', 'create_comment']),
    operationId: operationIdSchema,
    connectorAccountId: accountIdSchema,
    targetRef: z.string().min(1).optional(),
    exactFieldsHash: sha256Schema,
    externalPreconditionHash: sha256Schema.optional(),
  })
  .strict();

export const plannedEffectSchema = z.discriminatedUnion('kind', [
  communicationEffectSchema,
  workManagementEffectSchema,
]);

export const actionPlanSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    actionPlanId: actionPlanIdSchema,
    revision: z.number().int().positive(),
    sourceMessageRevisionId: messageRevisionIdSchema,
    operations: z.array(plannedEffectSchema).min(1),
    policyVersion: versionSchema,
    expiresAt: timestampSchema,
    canonicalHash: sha256Schema,
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const operationIds = plan.operations.map(({ operationId }) => operationId);
    if (new Set(operationIds).size !== operationIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'action-plan operation identifiers must be unique',
        path: ['operations'],
      });
    }
  });

export const approvalStatusSchema = z.enum([
  'active',
  'consumed',
  'revoked',
  'expired',
  'invalidated',
]);

export const approvalSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    approvalId: approvalIdSchema,
    actionPlanId: actionPlanIdSchema,
    actionPlanRevision: z.number().int().positive(),
    actionPlanHash: sha256Schema,
    sourceMessageRevisionId: messageRevisionIdSchema,
    approverUserId: userIdSchema,
    approvedAt: timestampSchema,
    expiresAt: timestampSchema,
    policyVersion: versionSchema,
    status: approvalStatusSchema,
    stateVersion: z.number().int().positive(),
    invalidationReason: z.string().min(1).optional(),
  })
  .strict();

export const executionIntentSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    executionIntentId: executionIntentIdSchema,
    approvalId: approvalIdSchema,
    actionPlanId: actionPlanIdSchema,
    actionPlanHash: sha256Schema,
    operationIds: z.array(operationIdSchema).min(1),
    status: z.enum(['ready', 'executing', 'settled', 'blocked']),
    createdAt: timestampSchema,
  })
  .strict();

export const clientCorrelationSchema = z
  .object({
    kind: z.enum(['rfc_message_id', 'provider_draft_id', 'client_reference']),
    value: z.string().min(1),
  })
  .strict();

export const effectExecutionArtifactSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    operationId: operationIdSchema,
    attemptId: attemptIdSchema,
    stableIdempotencyKey: z.string().min(1),
    account: connectorAccountRefSchema,
    sourceMessageRevisionId: messageRevisionIdSchema,
    actionPlanId: actionPlanIdSchema,
    actionPlanHash: sha256Schema,
    approvalId: approvalIdSchema,
    draftRevisionId: draftRevisionIdSchema.optional(),
    renderedPayloadFingerprint: sha256Schema,
    connectorSnapshot: connectorSnapshotSchema,
    clientCorrelation: clientCorrelationSchema,
    correlationBindingVersion: versionSchema,
    reconciliationStrategy: z.string().min(1),
    reconciliationStrategyVersion: versionSchema,
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      artifact.tenantId !== artifact.account.tenantId ||
      artifact.account.accountId !== artifact.connectorSnapshot.accountId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'effect artifact tenant, account, and snapshot must align',
        path: ['account'],
      });
    }
  });

export const providerSendResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('rejected'),
      providerResponseHash: sha256Schema,
      reasonCode: z.string().min(1),
      observedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('accepted'),
      providerResponseHash: sha256Schema,
      providerCorrelation: z.string().min(1),
      observedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('acceptance_unknown'),
      providerResponseHash: sha256Schema.optional(),
      reasonCode: z.string().min(1),
      observedAt: timestampSchema,
    })
    .strict(),
]);

export const reconcileSendRequestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    artifact: effectExecutionArtifactSchema,
    priorAttemptId: attemptIdSchema,
    strategy: z.string().min(1),
    strategyVersion: versionSchema,
    maxProviderQueries: z.number().int().positive().max(10),
  })
  .strict();

export const outboxItemSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    outboxItemId: outboxItemIdSchema,
    operationId: operationIdSchema,
    stableIdempotencyKey: z.string().min(1),
    approvalId: approvalIdSchema,
    actionPlanId: actionPlanIdSchema,
    status: z.enum([
      'ready',
      'claimed',
      'settled',
      'retryable',
      'reconciliation_required',
      'frozen',
    ]),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: timestampSchema.optional(),
    claimOwner: z.string().min(1).optional(),
    claimEpoch: z.number().int().positive().optional(),
    claimExpiresAt: timestampSchema.optional(),
    stateVersion: z.number().int().positive(),
  })
  .strict();

export const sendAttemptSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    operationId: operationIdSchema,
    attemptId: attemptIdSchema,
    artifactHash: sha256Schema,
    stableIdempotencyKey: z.string().min(1),
    lifecycleState: z.enum([
      'prepared',
      'dispatching',
      'settled',
      'reconciliation_required',
      'reconciled',
    ]),
    transportState: transportStateSchema,
    clientCorrelation: clientCorrelationSchema,
    providerCorrelationDigest: keyedDigestValueSchema.optional(),
    correlationBindingVersion: versionSchema,
    retryDecision: z.enum(['not_applicable', 'retry_allowed', 'retry_denied']),
    attemptedAt: timestampSchema,
    stateVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (
      ['provider_accepted', 'delivered', 'delivery_failed', 'bounced'].includes(
        attempt.transportState,
      ) &&
      attempt.providerCorrelationDigest === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'provider correlation must be persisted before accepted-or-later transport state',
        path: ['providerCorrelationDigest'],
      });
    }
    if (
      attempt.transportState === 'acceptance_unknown' &&
      (attempt.retryDecision !== 'retry_denied' ||
        attempt.lifecycleState !== 'reconciliation_required')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'acceptance_unknown must deny ordinary retry and require reconciliation',
        path: ['transportState'],
      });
    }
  });

export const riskAcknowledgementSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    frozenOperationId: operationIdSchema,
    newActionPlanId: actionPlanIdSchema,
    acknowledgedBy: userIdSchema,
    risk: z.literal('provider_may_have_already_accepted'),
    acknowledgedAt: timestampSchema,
  })
  .strict();

export const suppressionFactSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    factId: eventIdSchema,
    contactIdentityDigest: keyedDigestValueSchema,
    channel: z.string().min(1),
    connectorAccountId: accountIdSchema,
    brandId: brandIdSchema,
    kind: z.enum([
      'controlled_recipient_allow',
      'verified_opt_in',
      'verified_reconsent',
      'provider_opt_out',
      'unsubscribe',
      'complaint',
      'bounce',
      'legal_block',
      'window_open',
      'window_closed',
      'operator_block',
    ]),
    authority: z.enum([
      'provider',
      'legal',
      'operator',
      'controlled_allowlist',
    ]),
    providerEventId: z.string().min(1).optional(),
    rawEventRef: z.string().min(1).optional(),
    effectiveAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    supersedesFactId: eventIdSchema.optional(),
  })
  .strict();

export const contactPolicyStateSchema = z.enum([
  'allowed',
  'suppressed',
  'consent_required',
  'window_closed',
  'unknown',
]);

export const contactChannelPolicySchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    contactIdentityDigest: keyedDigestValueSchema,
    channel: z.string().min(1),
    connectorAccountId: accountIdSchema,
    brandId: brandIdSchema,
    state: contactPolicyStateSchema,
    winningFactId: eventIdSchema.optional(),
    applicableFactIds: z.array(eventIdSchema),
    reducerVersion: versionSchema,
    projectionVersion: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict();

export const feedbackContextSchema = z
  .object({
    tenantId: tenantIdSchema,
    account: connectorAccountRefSchema,
    connectorSnapshot: connectorSnapshotSchema,
    knownOperationId: operationIdSchema.optional(),
    knownAttemptId: attemptIdSchema.optional(),
  })
  .strict()
  .superRefine((feedback, context) => {
    if (
      feedback.tenantId !== feedback.account.tenantId ||
      feedback.account.accountId !== feedback.connectorSnapshot.accountId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'feedback tenant, account, and snapshot must align',
        path: ['account'],
      });
    }
  });

export const verifiedFeedbackFactSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    feedbackFactId: eventIdSchema,
    providerEventId: z.string().min(1).optional(),
    providerMessageId: z.string().min(1).optional(),
    providerCorrelation: z.string().min(1).optional(),
    operationId: operationIdSchema.optional(),
    attemptId: attemptIdSchema.optional(),
    feedbackKind: z.enum([
      'accepted',
      'delivered',
      'delivery_failed',
      'bounced',
      'reply',
      'complaint',
      'unsubscribe',
      'opt_out',
      'reconsent',
      'window_opened',
      'window_closed',
    ]),
    providerTimestamp: timestampSchema,
    rawEventRef: z.string().min(1),
    rawPayloadDigest: sha256Schema,
    connectorSnapshot: connectorSnapshotSchema,
    idempotencyDigest: keyedDigestValueSchema,
  })
  .strict();

export const feedbackParseResultSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('verified'), fact: verifiedFeedbackFactSchema })
    .strict(),
  z
    .object({ kind: z.literal('unsupported'), reason: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal('invalid'), reason: z.string().min(1) }).strict(),
]);

export const durableReplayRecordSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    replayId: z.string().min(1),
    kind: z.enum([
      'uncorrelated_feedback',
      'failed_atomic_write',
      'acceptance_unknown',
    ]),
    sourceRef: z.string().min(1),
    payloadHash: sha256Schema,
    status: z.enum(['pending', 'claimed', 'resolved', 'manual_review']),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: timestampSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict();

export type TransportState = z.infer<typeof transportStateSchema>;
export type WorkManagementEffect = z.infer<typeof workManagementEffectSchema>;
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type ExecutionIntent = z.infer<typeof executionIntentSchema>;
export type EffectExecutionArtifact = z.infer<
  typeof effectExecutionArtifactSchema
>;
export type ProviderSendResult = z.infer<typeof providerSendResultSchema>;
export type ReconcileSendRequest = z.infer<typeof reconcileSendRequestSchema>;
export type OutboxItem = z.infer<typeof outboxItemSchema>;
export type SendAttempt = z.infer<typeof sendAttemptSchema>;
export type RiskAcknowledgement = z.infer<typeof riskAcknowledgementSchema>;
export type SuppressionFact = z.infer<typeof suppressionFactSchema>;
export type ContactChannelPolicy = z.infer<typeof contactChannelPolicySchema>;
export type FeedbackContext = z.infer<typeof feedbackContextSchema>;
export type VerifiedFeedbackFact = z.infer<typeof verifiedFeedbackFactSchema>;
export type FeedbackParseResult = z.infer<typeof feedbackParseResultSchema>;
export type UnsupportedFeedback = Extract<
  FeedbackParseResult,
  { kind: 'unsupported' }
>;
export type InvalidFeedback = Extract<FeedbackParseResult, { kind: 'invalid' }>;
export type DurableReplayRecord = z.infer<typeof durableReplayRecordSchema>;

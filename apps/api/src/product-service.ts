import { z } from 'zod';

import {
  actionPlanIdSchema,
  approvalIdSchema,
  getApprovalStatusInputSchema,
  getSlaMetricsResultSchema,
  operationIdSchema,
  proposalIdSchema,
  sha256Schema,
  timestampSchema,
} from '@chief/contracts';
import type {
  getApprovalStatusResultSchema,
  getCommunicationInputSchema,
  getCommunicationResultSchema,
  getConnectorStatusInputSchema,
  getConnectorStatusResultSchema,
  getRelatedAsanaWorkInputSchema,
  getRelatedAsanaWorkResultSchema,
  getSlaMetricsInputSchema,
  getThreadContextInputSchema,
  getThreadContextResultSchema,
  listCommunicationsInputSchema,
  listCommunicationsResultSchema,
  prepareAsanaActionInputSchema,
  prepareAsanaActionResultSchema,
  recommendActionInputSchema,
  recommendActionResultSchema,
  requestContextInputSchema,
  requestContextResultSchema,
  reviseDraftInputSchema,
  reviseDraftResultSchema,
  searchKnowledgeInputSchema,
  searchKnowledgeResultSchema,
  serverRequestContextSchema,
  submitApprovalInputSchema,
  submitApprovalResultSchema,
  createDraftInputSchema,
  createDraftResultSchema,
} from '@chief/contracts';

export const dashboardMetricsResultSchema = z
  .object({
    snapshot: getSlaMetricsResultSchema.shape.snapshot,
    totalCommunications: z.number().int().nonnegative(),
    pendingApprovalCount: z.number().int().nonnegative(),
    channelBreakdown: z.array(
      z
        .object({
          channel: z.string().min(1).max(80),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const executionStatusInputSchema = z
  .object({ proposalId: getApprovalStatusInputSchema.shape.proposalId })
  .strict();

export const executionStatusResultSchema = z
  .object({
    proposalId: getApprovalStatusInputSchema.shape.proposalId,
    runtimeMode: z.literal('fixture'),
    storageMode: z.literal('durable'),
    effectPolicy: z.literal('effect_disabled'),
    externalEffect: z.literal(false),
    status: z.enum(['not_requested', 'pending_approval', 'effect_disabled']),
    receipt: z
      .object({
        kind: z.literal('effect_disabled'),
        operationId: z.string().min(1),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
        stableIdempotencyKey: z.string().min(1),
        observedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict();

export const prepareDraftApprovalInputSchema = z
  .object({
    draftRevisionId: z.string().min(1),
    expectedDraftRevision: z.number().int().positive(),
  })
  .strict();

export const prepareDraftApprovalResultSchema = z
  .object({
    proposalId: proposalIdSchema,
    approvalUrl: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:'),
    status: z.enum(['pending_approval', 'approved']),
    directEffectAvailable: z.literal(false),
    actionPlanId: actionPlanIdSchema,
    actionPlanRevision: z.number().int().positive(),
    actionPlanHash: sha256Schema,
    updatedAt: timestampSchema,
  })
  .strict();

export const approveProposalInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    expectedProposalUpdatedAt: timestampSchema,
  })
  .strict();

const effectDisabledReceiptSchema = z
  .object({
    kind: z.literal('effect_disabled'),
    operationId: operationIdSchema,
    artifactHash: sha256Schema,
    stableIdempotencyKey: z.string().min(1),
    observedAt: timestampSchema,
  })
  .strict();

export const approveProposalResultSchema = z
  .object({
    proposalId: proposalIdSchema,
    actionPlanId: actionPlanIdSchema,
    actionPlanRevision: z.number().int().positive(),
    actionPlanHash: sha256Schema,
    approvalId: approvalIdSchema,
    operationId: operationIdSchema,
    status: z.literal('approved'),
    effectPolicy: z.literal('effect_disabled'),
    externalEffect: z.literal(false),
    receipt: effectDisabledReceiptSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type ProductRequestContext = z.infer<typeof serverRequestContextSchema>;
export type DashboardMetricsResult = z.infer<
  typeof dashboardMetricsResultSchema
>;
export type ExecutionStatusResult = z.infer<typeof executionStatusResultSchema>;
export type PrepareDraftApprovalResult = z.infer<
  typeof prepareDraftApprovalResultSchema
>;
export type ApproveProposalResult = z.infer<typeof approveProposalResultSchema>;
export type ProductResult<T> = T | Promise<T>;

export class ProductServiceError extends Error {
  public constructor(
    public readonly code:
      | 'BAD_CURSOR'
      | 'NOT_FOUND'
      | 'STALE_REVISION'
      | 'FORBIDDEN_AUTHORITY'
      | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ProductServiceError';
  }
}

export interface ProductService {
  dashboardMetrics(
    context: ProductRequestContext,
    input: z.infer<typeof getSlaMetricsInputSchema>,
  ): ProductResult<DashboardMetricsResult>;
  getSlaMetrics(
    context: ProductRequestContext,
    input: z.infer<typeof getSlaMetricsInputSchema>,
  ): ProductResult<z.infer<typeof getSlaMetricsResultSchema>>;
  listCommunications(
    context: ProductRequestContext,
    input: z.infer<typeof listCommunicationsInputSchema>,
  ): ProductResult<z.infer<typeof listCommunicationsResultSchema>>;
  getCommunication(
    context: ProductRequestContext,
    input: z.infer<typeof getCommunicationInputSchema>,
  ): ProductResult<z.infer<typeof getCommunicationResultSchema>>;
  getThreadContext(
    context: ProductRequestContext,
    input: z.infer<typeof getThreadContextInputSchema>,
  ): ProductResult<z.infer<typeof getThreadContextResultSchema>>;
  getConnectorStatus(
    context: ProductRequestContext,
    input: z.infer<typeof getConnectorStatusInputSchema>,
  ): ProductResult<z.infer<typeof getConnectorStatusResultSchema>>;
  getRelatedAsanaWork(
    context: ProductRequestContext,
    input: z.infer<typeof getRelatedAsanaWorkInputSchema>,
  ): ProductResult<z.infer<typeof getRelatedAsanaWorkResultSchema>>;
  searchKnowledge(
    context: ProductRequestContext,
    input: z.infer<typeof searchKnowledgeInputSchema>,
  ): ProductResult<z.infer<typeof searchKnowledgeResultSchema>>;
  recommendAction(
    context: ProductRequestContext,
    input: z.infer<typeof recommendActionInputSchema>,
  ): ProductResult<z.infer<typeof recommendActionResultSchema>>;
  createDraft(
    context: ProductRequestContext,
    input: z.infer<typeof createDraftInputSchema>,
  ): ProductResult<z.infer<typeof createDraftResultSchema>>;
  reviseDraft(
    context: ProductRequestContext,
    input: z.infer<typeof reviseDraftInputSchema>,
  ): ProductResult<z.infer<typeof reviseDraftResultSchema>>;
  requestContext(
    context: ProductRequestContext,
    input: z.infer<typeof requestContextInputSchema>,
  ): ProductResult<z.infer<typeof requestContextResultSchema>>;
  prepareApproval(
    context: ProductRequestContext,
    input: z.infer<typeof submitApprovalInputSchema>,
  ): ProductResult<z.infer<typeof submitApprovalResultSchema>>;
  prepareDraftApproval(
    context: ProductRequestContext,
    input: z.infer<typeof prepareDraftApprovalInputSchema>,
  ): ProductResult<PrepareDraftApprovalResult>;
  approveProposal(
    context: ProductRequestContext,
    input: z.infer<typeof approveProposalInputSchema>,
  ): ProductResult<ApproveProposalResult>;
  prepareAsanaAction(
    context: ProductRequestContext,
    input: z.infer<typeof prepareAsanaActionInputSchema>,
  ): ProductResult<z.infer<typeof prepareAsanaActionResultSchema>>;
  getApprovalStatus(
    context: ProductRequestContext,
    input: z.infer<typeof getApprovalStatusInputSchema>,
  ): ProductResult<z.infer<typeof getApprovalStatusResultSchema>>;
  getExecutionStatus(
    context: ProductRequestContext,
    input: z.infer<typeof executionStatusInputSchema>,
  ): ProductResult<ExecutionStatusResult>;
}

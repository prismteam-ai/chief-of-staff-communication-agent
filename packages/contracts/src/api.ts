import { z } from 'zod';

import {
  actionRecommendationSchema,
  citedDraftResultSchema,
  contextRequestSchema,
} from './agent.js';
import {
  connectorCapabilitiesSchema,
  connectorRuntimeModeSchema,
  connectorSelectionStateSchema,
  workManagementCapabilitiesSchema,
  workObjectFactSchema,
} from './connectors.js';
import {
  accountIdSchema,
  actionPlanIdSchema,
  attachmentIdSchema,
  brandIdSchema,
  draftRevisionIdSchema,
  messageIdSchema,
  messageRevisionIdSchema,
  proposalIdSchema,
  recommendationIdSchema,
  sha256Schema,
  threadIdSchema,
  timestampSchema,
} from './ids.js';
import { citationSchema, retrievalCandidateSchema } from './knowledge.js';
import { serverScopeSchema, verifiedActorContextSchema } from './tenancy.js';

export const serverRequestContextSchema = z
  .object({
    actor: verifiedActorContextSchema,
    retrievalScope: serverScopeSchema.optional(),
  })
  .strict();

export const authenticatedProductUrlSchema = z
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'authenticated product links must use HTTPS',
  });

export const communicationStatusSchema = z.enum([
  'pending',
  'answered',
  'overdue',
  'resolved',
]);

export const communicationSummaryViewSchema = z
  .object({
    messageId: messageIdSchema,
    messageRevisionId: messageRevisionIdSchema,
    revision: z.number().int().positive(),
    threadId: threadIdSchema,
    direction: z.enum(['inbound', 'outbound']),
    status: communicationStatusSchema,
    senderDisplayName: z.string().min(1).max(200).optional(),
    recipientDisplayNames: z.array(z.string().min(1).max(200)),
    subject: z.string().max(998).optional(),
    excerpt: z.string().max(1_000),
    attachmentCount: z.number().int().nonnegative(),
    sourceTimestamp: timestampSchema,
    productUrl: authenticatedProductUrlSchema,
  })
  .strict();

export const communicationAttachmentViewSchema = z
  .object({
    attachmentId: attachmentIdSchema,
    fileName: z.string().min(1).max(512),
    mediaType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    malwareState: z.enum(['pending', 'clean', 'infected', 'failed']),
    productUrl: authenticatedProductUrlSchema,
  })
  .strict();

export const communicationDetailViewSchema = communicationSummaryViewSchema
  .extend({
    authoredText: z.string(),
    normalizedText: z.string(),
    attachments: z.array(communicationAttachmentViewSchema),
    citations: z.array(citationSchema),
  })
  .strict();

export const threadContextViewSchema = z
  .object({
    threadId: threadIdSchema,
    channel: z.string().min(1),
    subject: z.string().max(998).optional(),
    participantDisplayNames: z.array(z.string().min(1).max(200)),
    status: z.enum(['active', 'archived', 'deleted']),
    latestMessageRevisionId: messageRevisionIdSchema,
    sourceUpdatedAt: timestampSchema,
    communications: z.array(communicationSummaryViewSchema),
    nextCursor: z.string().min(1).optional(),
    productUrl: authenticatedProductUrlSchema,
  })
  .strict();

export const connectorStatusViewSchema = z
  .object({
    accountId: accountIdSchema,
    brandId: brandIdSchema.optional(),
    connectorId: z.string().min(1),
    displayLabel: z.string().min(1).max(200),
    provider: z.string().min(1),
    connectorKind: z.enum(['communication', 'work_management']),
    channel: z.string().min(1).optional(),
    status: z.enum(['pending', 'active', 'degraded', 'revoked', 'disabled']),
    health: z.enum(['unknown', 'healthy', 'degraded', 'failed']),
    runtimeMode: connectorRuntimeModeSchema,
    selectionState: connectorSelectionStateSchema,
    capabilities: z.union([
      connectorCapabilitiesSchema,
      workManagementCapabilitiesSchema,
    ]),
    lastSyncAt: timestampSchema.optional(),
    authorizationExpiresAt: timestampSchema.optional(),
    productUrl: authenticatedProductUrlSchema,
  })
  .strict();

export const listCommunicationsInputSchema = z
  .object({
    status: z.enum(['pending', 'answered', 'overdue', 'resolved']).optional(),
    limit: z.number().int().positive().max(100),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const listCommunicationsResultSchema = z
  .object({
    items: z.array(communicationSummaryViewSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

export const getCommunicationInputSchema = z
  .object({ messageRevisionId: messageRevisionIdSchema })
  .strict();

export const getCommunicationResultSchema = z
  .object({ communication: communicationDetailViewSchema })
  .strict();

export const getThreadContextInputSchema = z
  .object({
    threadId: threadIdSchema,
    limit: z.number().int().positive().max(100),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const getThreadContextResultSchema = z
  .object({ thread: threadContextViewSchema })
  .strict();

export const searchKnowledgeInputSchema = z
  .object({
    queryText: z.string().min(1).max(16_000),
    exactEntityRefs: z.array(z.string().min(1)).max(100),
    limit: z.number().int().positive().max(100),
  })
  .strict();

export const searchKnowledgeResultSchema = z
  .object({
    candidates: z.array(retrievalCandidateSchema),
    citations: z.array(citationSchema),
  })
  .strict();

export const getRelatedAsanaWorkInputSchema = z
  .object({
    messageRevisionId: messageRevisionIdSchema,
    limit: z.number().int().positive().max(100),
  })
  .strict();

export const getRelatedAsanaWorkResultSchema = z
  .object({ items: z.array(workObjectFactSchema) })
  .strict();

export const recommendActionInputSchema = z
  .object({
    messageRevisionId: messageRevisionIdSchema,
    expectedMessageRevision: z.number().int().positive(),
  })
  .strict();

export const recommendActionResultSchema = z
  .object({ recommendation: actionRecommendationSchema })
  .strict();

export const createDraftInputSchema = z
  .object({
    recommendationId: recommendationIdSchema,
    expectedRecommendationRevision: z.number().int().positive(),
  })
  .strict();

export const createDraftResultSchema = z
  .object({ result: citedDraftResultSchema })
  .strict();

export const reviseDraftInputSchema = z
  .object({
    draftRevisionId: draftRevisionIdSchema,
    expectedDraftRevision: z.number().int().positive(),
    revisionInstruction: z.string().min(1).max(16_000),
  })
  .strict();

export const reviseDraftResultSchema = createDraftResultSchema;

export const requestContextInputSchema = z
  .object({
    recommendationId: recommendationIdSchema,
    expectedRecommendationRevision: z.number().int().positive(),
    focusedQuestion: z.string().min(1).max(4_000).optional(),
  })
  .strict();

export const requestContextResultSchema = z
  .object({ request: contextRequestSchema })
  .strict();

export const submitApprovalInputSchema = z
  .object({
    actionPlanId: actionPlanIdSchema,
    expectedActionPlanRevision: z.number().int().positive(),
    actionPlanHash: sha256Schema,
  })
  .strict();

export const proposalHandoffSchema = z
  .object({
    proposalId: proposalIdSchema,
    approvalUrl: authenticatedProductUrlSchema,
    status: z.enum(['prepared', 'pending_approval']),
    directEffectAvailable: z.literal(false),
  })
  .strict();

export const prepareAsanaActionInputSchema = z
  .object({
    recommendationId: recommendationIdSchema,
    expectedRecommendationRevision: z.number().int().positive(),
  })
  .strict();

export const prepareAsanaActionResultSchema = proposalHandoffSchema;
export const submitApprovalResultSchema = proposalHandoffSchema;

export const getApprovalStatusInputSchema = z
  .object({ proposalId: proposalIdSchema })
  .strict();

export const proposalStatusSchema = z.enum([
  'prepared',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);

export const getApprovalStatusResultSchema = z
  .object({
    proposalId: proposalIdSchema,
    status: proposalStatusSchema,
    approvalUrl: authenticatedProductUrlSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict();

export const getConnectorStatusInputSchema = z
  .object({ connectorId: z.string().min(1).optional() })
  .strict();

export const getConnectorStatusResultSchema = z
  .object({ connectors: z.array(connectorStatusViewSchema) })
  .strict();

export const slaWindowSchema = z.enum(['24h', '7d', '30d']);

export const getSlaMetricsInputSchema = z
  .object({ window: slaWindowSchema })
  .strict();

export const slaSnapshotSchema = z
  .object({
    schemaVersion: z.literal('1'),
    window: slaWindowSchema,
    measuredAt: timestampSchema,
    pendingCount: z.number().int().nonnegative(),
    overdueCount: z.number().int().nonnegative(),
    answeredCount: z.number().int().nonnegative(),
    resolvedCount: z.number().int().nonnegative(),
    responseTimeP50Ms: z.number().int().nonnegative().optional(),
    responseTimeP95Ms: z.number().int().nonnegative().optional(),
    ingestionLagP95Ms: z.number().int().nonnegative().optional(),
  })
  .strict();

export const getSlaMetricsResultSchema = z
  .object({ snapshot: slaSnapshotSchema })
  .strict();

export type CommunicationSummaryView = z.infer<
  typeof communicationSummaryViewSchema
>;
export type CommunicationAttachmentView = z.infer<
  typeof communicationAttachmentViewSchema
>;
export type CommunicationDetailView = z.infer<
  typeof communicationDetailViewSchema
>;
export type ThreadContextView = z.infer<typeof threadContextViewSchema>;
export type ConnectorStatusView = z.infer<typeof connectorStatusViewSchema>;
export type ProposalHandoff = z.infer<typeof proposalHandoffSchema>;
export type SlaSnapshot = z.infer<typeof slaSnapshotSchema>;

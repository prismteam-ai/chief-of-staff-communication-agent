import { z } from 'zod';

import {
  accountIdSchema,
  draftIdSchema,
  draftRevisionIdSchema,
  keyedDigestValueSchema,
  messageRevisionIdSchema,
  recommendationIdSchema,
  sha256Schema,
  tenantIdSchema,
  timestampSchema,
  versionSchema,
} from './ids.js';
import { citationSchema } from './knowledge.js';

export const actionTypeSchema = z.enum([
  'reply',
  'acknowledge',
  'request_context',
  'schedule',
  'delegate',
  'create_asana_task',
  'update_asana_task',
  'escalate',
  'archive',
  'ignore_system',
  'no_action',
]);

export const reproducibilityManifestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    selectedProfileManifestHash: sha256Schema,
    routeId: z.string().min(1),
    modelProfileId: z.string().min(1),
    gatewayVersion: versionSchema,
    promptHash: sha256Schema,
    policyHash: sha256Schema,
    schemaHash: sha256Schema,
    retrievalQueryHash: sha256Schema,
    retrievalSnapshotManifestHash: sha256Schema,
    requestHash: sha256Schema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    outcome: z.enum(['valid', 'refused', 'timeout', 'invalid', 'degraded']),
  })
  .strict();

export const selectedProfileManifestSchema = z.discriminatedUnion('workload', [
  z
    .object({
      schemaVersion: z.literal('1'),
      workload: z.literal('embedding'),
      manifestHash: sha256Schema,
      profileId: z.string().min(1),
      region: z.string().min(1),
      effectiveRetentionDays: z.literal(0),
      gatewayVersion: versionSchema,
      vectorDimension: z.number().int().positive(),
      normalizationVersion: versionSchema,
      reindexGeneration: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal('1'),
      workload: z.literal('generation'),
      manifestHash: sha256Schema,
      profileId: z.string().min(1),
      region: z.string().min(1),
      effectiveRetentionDays: z.literal(0),
      gatewayVersion: versionSchema,
      actionContextRoute: z.string().min(1),
      draftRoute: z.string().min(1),
      promptPolicyHash: sha256Schema,
      degradedMode: z.enum(['needs_context', 'agent_error']),
    })
    .strict(),
]);

export const actionRecommendationSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    recommendationId: recommendationIdSchema,
    revision: z.number().int().positive(),
    sourceMessageRevisionId: messageRevisionIdSchema,
    actionType: actionTypeSchema,
    structuredParameters: z.record(z.string(), z.unknown()),
    confidence: z.number().min(0).max(1),
    urgency: z.enum(['low', 'normal', 'high', 'critical']),
    reasonSummary: z.string().min(1),
    citations: z.array(citationSchema),
    missingFacts: z.array(z.string().min(1)),
    status: z.enum([
      'candidate',
      'current',
      'superseded',
      'needs_context',
      'blocked',
    ]),
    reproducibility: reproducibilityManifestSchema,
    createdAt: timestampSchema,
  })
  .strict();

export const recommendationHeadSchema = z
  .object({
    tenantId: tenantIdSchema,
    sourceMessageRevisionId: messageRevisionIdSchema,
    recommendationId: recommendationIdSchema,
    revision: z.number().int().positive(),
    headVersion: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict();

export const contextRequestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    contextRequestId: z.string().min(1),
    recommendationId: recommendationIdSchema,
    focusedQuestion: z.string().min(1),
    missingFacts: z.array(z.string().min(1)).min(1),
    state: z.enum(['open', 'answered', 'cancelled']),
    responseEvidenceRefs: z.array(z.string().min(1)),
    createdAt: timestampSchema,
    answeredAt: timestampSchema.optional(),
  })
  .strict();

export const draftSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    draftId: draftIdSchema,
    sourceMessageRevisionId: messageRevisionIdSchema,
    currentRevisionId: draftRevisionIdSchema,
    currentRevision: z.number().int().positive(),
    status: z.enum(['draft', 'pending_approval', 'approved', 'superseded']),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const draftRevisionSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    draftId: draftIdSchema,
    draftRevisionId: draftRevisionIdSchema,
    revision: z.number().int().positive(),
    connectorAccountId: accountIdSchema,
    sourceMessageRevisionId: messageRevisionIdSchema,
    recipientDigests: z.array(keyedDigestValueSchema).min(1),
    subject: z.string().max(998).optional(),
    body: z.string().min(1),
    attachmentContentHashes: z.array(sha256Schema),
    citations: z.array(citationSchema),
    styleProfileVersion: versionSchema,
    rendererId: z.string().min(1),
    rendererVersion: versionSchema,
    renderedPayloadFingerprint: sha256Schema,
    contentHash: sha256Schema,
    createdBy: z.enum(['agent', 'user']),
    supersedesRevisionId: draftRevisionIdSchema.optional(),
    reproducibility: reproducibilityManifestSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict();

export const draftHeadSchema = z
  .object({
    tenantId: tenantIdSchema,
    draftId: draftIdSchema,
    draftRevisionId: draftRevisionIdSchema,
    revision: z.number().int().positive(),
    headVersion: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict();

export const citedDraftResultSchema = z
  .object({
    draft: draftRevisionSchema,
    factualCitationCount: z.number().int().nonnegative(),
    unresolvedFacts: z.array(z.string().min(1)),
    validation: z.enum(['passed', 'needs_context', 'blocked']),
  })
  .strict();

export type ActionRecommendation = z.infer<typeof actionRecommendationSchema>;
export type SelectedProfileManifest = z.infer<
  typeof selectedProfileManifestSchema
>;
export type RecommendationHead = z.infer<typeof recommendationHeadSchema>;
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftRevision = z.infer<typeof draftRevisionSchema>;
export type DraftHead = z.infer<typeof draftHeadSchema>;
export type CitedDraftResult = z.infer<typeof citedDraftResultSchema>;

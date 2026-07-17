import { z } from 'zod';

const identifier = z.string().trim().min(1).max(160);

export const tenantIdSchema = identifier.brand<'TenantId'>();
export const userIdSchema = identifier.brand<'UserId'>();
export const accountIdSchema = identifier.brand<'ConnectorAccountId'>();
export const brandIdSchema = identifier.brand<'BrandId'>();
export const messageIdSchema = identifier.brand<'MessageId'>();
export const messageRevisionIdSchema = identifier.brand<'MessageRevisionId'>();
export const threadIdSchema = identifier.brand<'ThreadId'>();
export const attachmentIdSchema = identifier.brand<'AttachmentId'>();
export const sourceIdSchema = identifier.brand<'KnowledgeSourceId'>();
export const chunkIdSchema = identifier.brand<'KnowledgeChunkId'>();
export const recommendationIdSchema = identifier.brand<'RecommendationId'>();
export const draftIdSchema = identifier.brand<'DraftId'>();
export const draftRevisionIdSchema = identifier.brand<'DraftRevisionId'>();
export const approvalIdSchema = identifier.brand<'ApprovalId'>();
export const actionPlanIdSchema = identifier.brand<'ActionPlanId'>();
export const executionIntentIdSchema = identifier.brand<'ExecutionIntentId'>();
export const operationIdSchema = identifier.brand<'OperationId'>();
export const attemptIdSchema = identifier.brand<'AttemptId'>();
export const eventIdSchema = identifier.brand<'EventId'>();
export const outboxItemIdSchema = identifier.brand<'OutboxItemId'>();
export const topicLinkIdSchema = identifier.brand<'TopicLinkId'>();
export const proposalIdSchema = identifier.brand<'ProposalId'>();

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest');
export const digestKeyVersionSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u,
    'expected a canonical digest key version',
  );
export const keyedDigestValueSchema = z
  .string()
  .regex(
    /^h1_[A-Za-z0-9][A-Za-z0-9_-]{0,31}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
    'expected a canonical h1 keyed SHA-256 digest',
  )
  .brand<'KeyedDigestValue'>();
export const versionSchema = z.string().trim().min(1).max(80);
export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export const positiveEpochSchema = z.number().int().positive();
export const timestampSchema = z.iso.datetime({ offset: true });

export type TenantId = z.infer<typeof tenantIdSchema>;
export type UserId = z.infer<typeof userIdSchema>;
export type ConnectorAccountId = z.infer<typeof accountIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type MessageRevisionId = z.infer<typeof messageRevisionIdSchema>;
export type ThreadId = z.infer<typeof threadIdSchema>;
export type RecommendationId = z.infer<typeof recommendationIdSchema>;
export type DraftId = z.infer<typeof draftIdSchema>;
export type DraftRevisionId = z.infer<typeof draftRevisionIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;
export type ProposalId = z.infer<typeof proposalIdSchema>;
export type DigestKeyVersion = z.infer<typeof digestKeyVersionSchema>;
export type KeyedDigestValue = z.infer<typeof keyedDigestValueSchema>;

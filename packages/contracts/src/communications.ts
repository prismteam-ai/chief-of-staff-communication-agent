import { z } from 'zod';

import { connectorSnapshotSchema } from './connectors.js';
import {
  attachmentIdSchema,
  keyedDigestValueSchema,
  messageIdSchema,
  messageRevisionIdSchema,
  sha256Schema,
  tenantIdSchema,
  threadIdSchema,
  timestampSchema,
  topicLinkIdSchema,
  versionSchema,
} from './ids.js';
import { immutableBlobRefSchema } from './storage.js';

export const channelAddressSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    identityDigest: keyedDigestValueSchema,
    encryptedAddressRef: z.string().min(1),
  })
  .strict();

export const providerThreadSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    threadId: threadIdSchema,
    connectorSnapshot: connectorSnapshotSchema,
    providerThreadIdDigest: keyedDigestValueSchema,
    channel: z.string().min(1),
    participantDigests: z.array(keyedDigestValueSchema),
    subject: z.string().max(998).optional(),
    latestMessageRevisionId: messageRevisionIdSchema,
    version: z.number().int().positive(),
    sourceUpdatedAt: timestampSchema,
    status: z.enum(['active', 'archived', 'deleted']),
  })
  .strict();

export const messageSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    messageId: messageIdSchema,
    threadId: threadIdSchema,
    currentRevisionId: messageRevisionIdSchema,
    currentRevision: z.number().int().positive(),
    direction: z.enum(['inbound', 'outbound']),
    state: z.enum(['active', 'superseded', 'deleted']),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const topicSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    topicId: z.string().min(1),
    name: z.string().min(1).max(300),
    kind: z.enum(['person', 'customer', 'project', 'decision', 'workstream']),
    state: z.enum(['active', 'archived']),
    version: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const authoredBoundarySchema = z
  .object({
    kind: z.enum(['authored', 'quote', 'forward', 'signature']),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.end >= value.start, {
    message: 'boundary end must not precede start',
  });

export const authoredSegmentSchema = z
  .object({
    parserVersion: versionSchema,
    inputBodyHash: sha256Schema,
    authoredText: z.string(),
    boundaries: z.array(authoredBoundarySchema),
    confidence: z.number().min(0).max(1),
    ambiguityReasons: z.array(z.string().min(1)),
    localeMarkers: z.array(z.string().min(1)),
    derivedAt: timestampSchema,
  })
  .strict();

export const attachmentSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    attachmentId: attachmentIdSchema,
    sourceMessageRevisionId: messageRevisionIdSchema,
    providerAttachmentIdDigest: keyedDigestValueSchema,
    fileName: z.string().min(1).max(512),
    mediaType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    contentHash: sha256Schema,
    blob: immutableBlobRefSchema,
    malwareState: z.enum(['pending', 'clean', 'infected', 'failed']),
    extractionState: z.enum(['not_requested', 'pending', 'complete', 'failed']),
  })
  .strict();

export const messageRevisionSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    messageId: messageIdSchema,
    revisionId: messageRevisionIdSchema,
    revision: z.number().int().positive(),
    threadId: threadIdSchema,
    connectorSnapshot: connectorSnapshotSchema,
    providerMessageIdDigest: keyedDigestValueSchema,
    providerThreadIdDigest: keyedDigestValueSchema.optional(),
    direction: z.enum(['inbound', 'outbound']),
    sender: channelAddressSchema,
    recipients: z.array(channelAddressSchema).min(1),
    subject: z.string().max(998).optional(),
    immutableProviderBody: immutableBlobRefSchema,
    fullNormalizedBody: immutableBlobRefSchema,
    currentAuthoredSegment: authoredSegmentSchema,
    attachmentIds: z.array(attachmentIdSchema),
    replyToMessageId: messageIdSchema.optional(),
    supersedesRevisionId: messageRevisionIdSchema.optional(),
    sourceTimestamp: timestampSchema,
    ingestedAt: timestampSchema,
    contentHash: sha256Schema,
    visibility: z.enum(['private', 'tenant', 'account_scoped']),
  })
  .strict();

export const topicLinkSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    topicLinkId: topicLinkIdSchema,
    revision: z.number().int().positive(),
    communicationRef: z.string().min(1),
    linkedEntityType: z.enum([
      'person',
      'customer',
      'project',
      'decision',
      'asana_object',
    ]),
    linkedEntityId: z.string().min(1),
    method: z.enum(['exact', 'metadata', 'vector', 'manual']),
    score: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string().min(1)),
    reviewState: z.enum(['candidate', 'reviewed', 'rejected']),
    supersedesRevision: z.number().int().positive().optional(),
    createdAt: timestampSchema,
  })
  .strict();

export type ProviderThread = z.infer<typeof providerThreadSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageRevision = z.infer<typeof messageRevisionSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type TopicLink = z.infer<typeof topicLinkSchema>;

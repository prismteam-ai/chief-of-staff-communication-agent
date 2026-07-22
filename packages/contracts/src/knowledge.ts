import { z } from 'zod';

import {
  chunkIdSchema,
  sha256Schema,
  sourceIdSchema,
  tenantIdSchema,
  timestampSchema,
  versionSchema,
} from './ids.js';
import { immutableBlobRefSchema } from './storage.js';
import { serverScopeSchema } from './tenancy.js';

export const knowledgeRoleSchema = z.enum(['factual', 'style']);

export const knowledgeSourceSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    sourceId: sourceIdSchema,
    sourceVersion: versionSchema,
    sourceType: z.enum([
      'message',
      'thread',
      'conversation_group',
      'asana_object',
      'user_preference',
      'organization_knowledge',
      'style_example',
      'decision',
    ]),
    role: knowledgeRoleSchema,
    scopeHash: sha256Schema,
    sourceTimestamp: timestampSchema,
    contentHash: sha256Schema,
    body: immutableBlobRefSchema,
    state: z.enum(['pending', 'indexed', 'denied', 'deleted', 'failed']),
  })
  .strict();

export const knowledgeChunkSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    chunkId: chunkIdSchema,
    sourceId: sourceIdSchema,
    sourceVersion: versionSchema,
    role: knowledgeRoleSchema,
    scopeHash: sha256Schema,
    ordinal: z.number().int().nonnegative(),
    tokenCount: z.number().int().nonnegative(),
    textBody: immutableBlobRefSchema,
    contentHash: sha256Schema,
    embeddingProfileManifestHash: sha256Schema,
    embeddingProfileId: z.string().min(1),
    vectorDimension: z.number().int().positive(),
    normalizationVersion: versionSchema,
    reindexGeneration: z.number().int().positive(),
    citationLabel: z.string().min(1),
    sourceTimestamp: timestampSchema,
    state: z.enum(['active', 'denied', 'tombstoned']),
  })
  .strict();

export const retrievalScopeSchema = serverScopeSchema.extend({
  role: knowledgeRoleSchema,
});

export const retrievalQuerySchema = z
  .object({
    schemaVersion: z.literal('1'),
    scope: retrievalScopeSchema,
    queryText: z.string().min(1).max(16_000),
    exactEntityRefs: z.array(z.string().min(1)).max(100),
    limit: z.number().int().positive().max(100),
    embeddingProfileManifestHash: sha256Schema,
    queryHash: sha256Schema,
  })
  .strict();

export const retrievalCandidateSchema = z
  .object({
    chunkId: chunkIdSchema,
    sourceId: sourceIdSchema,
    lexicalScore: z.number().finite(),
    vectorScore: z.number().finite(),
    fusedScore: z.number().finite(),
    authorizationEpoch: z.number().int().positive(),
  })
  .strict();

export const citationSchema = z
  .object({
    citationId: z.string().min(1),
    sourceId: sourceIdSchema,
    sourceVersion: versionSchema,
    chunkId: chunkIdSchema,
    label: z.string().min(1),
    contentHash: sha256Schema,
    hydratedUnderAuthorizationEpoch: z.number().int().positive(),
  })
  .strict();

export const snapshotShardSchema = z
  .object({
    chunkIdObject: immutableBlobRefSchema,
    vectorObject: immutableBlobRefSchema,
    chunkCount: z.number().int().nonnegative(),
    decodedBytes: z.number().int().nonnegative(),
  })
  .strict();

export const retrievalSnapshotManifestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    role: knowledgeRoleSchema,
    scopeHash: sha256Schema,
    generation: z.number().int().positive(),
    authorizationEpoch: z.number().int().positive(),
    sourceWatermark: z.string().min(1),
    embeddingProfileManifestHash: sha256Schema,
    vectorDimension: z.number().int().positive(),
    normalizationVersion: versionSchema,
    lexicalScoringVersion: versionSchema,
    vectorFormat: z.literal('binary32-le-row-major'),
    shards: z.array(snapshotShardSchema).min(1).max(4),
    sourceCount: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative().max(10_000),
    serializedBytes: z.number().int().nonnegative().max(67_108_864),
    decodedBytes: z.number().int().nonnegative().max(134_217_728),
    manifestHash: sha256Schema,
    createdAt: timestampSchema,
  })
  .strict();

export const retrievalDeltaManifestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    role: knowledgeRoleSchema,
    scopeHash: sha256Schema,
    baseGeneration: z.number().int().positive(),
    authorizationEpoch: z.number().int().positive(),
    sequenceStart: z.number().int().nonnegative(),
    sequenceEnd: z.number().int().nonnegative(),
    changeCount: z.number().int().nonnegative().max(256),
    byteLength: z.number().int().nonnegative().max(4_194_304),
    object: immutableBlobRefSchema,
    manifestHash: sha256Schema,
    createdAt: timestampSchema,
  })
  .strict()
  .refine((value) => value.sequenceEnd >= value.sequenceStart, {
    message: 'delta sequence must be monotonic',
  });

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;
export type RetrievalScope = z.infer<typeof retrievalScopeSchema>;
export type RetrievalQuery = z.infer<typeof retrievalQuerySchema>;
export type RetrievalCandidate = z.infer<typeof retrievalCandidateSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type RetrievalSnapshotManifest = z.infer<
  typeof retrievalSnapshotManifestSchema
>;
export type RetrievalDeltaManifest = z.infer<
  typeof retrievalDeltaManifestSchema
>;

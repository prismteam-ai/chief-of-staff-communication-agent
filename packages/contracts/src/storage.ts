import { z } from 'zod';

import {
  digestKeyVersionSchema,
  keyedDigestValueSchema,
  sha256Schema,
  tenantIdSchema,
  versionSchema,
} from './ids.js';

export const immutableBlobRefSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    bucketRef: z.string().min(1),
    objectKey: z.string().min(1),
    objectVersion: z.string().min(1),
    contentHash: sha256Schema,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    encryptionKeyRef: z.string().min(1),
    retentionPolicyVersion: versionSchema,
  })
  .strict();

export const sensitiveIdentifierDigestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    tenantId: tenantIdSchema,
    purpose: z.string().min(1),
    normalizationVersion: versionSchema,
    keyVersion: digestKeyVersionSchema,
    digest: keyedDigestValueSchema,
  })
  .strict()
  .superRefine((identifier, context) => {
    if (!identifier.digest.startsWith(`h1_${identifier.keyVersion}_`)) {
      context.addIssue({
        code: 'custom',
        message: 'digest value must bind the declared key version',
        path: ['digest'],
      });
    }
  });

export const persistenceConditionSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    expectedEpoch: z.number().int().positive().optional(),
  })
  .strict();

export type ImmutableBlobRef = z.infer<typeof immutableBlobRefSchema>;
export type SensitiveIdentifierDigest = z.infer<
  typeof sensitiveIdentifierDigestSchema
>;

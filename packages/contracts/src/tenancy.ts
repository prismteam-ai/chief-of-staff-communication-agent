import { z } from 'zod';

import {
  accountIdSchema,
  brandIdSchema,
  keyedDigestValueSchema,
  sha256Schema,
  tenantIdSchema,
  timestampSchema,
  userIdSchema,
  versionSchema,
} from './ids.js';

export const tenantSchema = z
  .object({
    tenantId: tenantIdSchema,
    name: z.string().min(1).max(200),
    status: z.enum(['active', 'suspended', 'deleting']),
    dataRegion: z.string().min(1),
    retentionPolicyVersion: versionSchema,
    approvalPolicyVersion: versionSchema,
    encryptionKeyRef: z.string().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const userSchema = z
  .object({
    userId: userIdSchema,
    identityProviderSubjectDigest: keyedDigestValueSchema,
    displayName: z.string().min(1).max(200),
    timeZone: z.string().min(1),
    locale: z.string().min(2),
    status: z.enum(['active', 'disabled']),
  })
  .strict();

export const membershipSchema = z
  .object({
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    role: z.enum(['owner', 'executive', 'delegate', 'viewer', 'service']),
    policyGrants: z.array(z.string().min(1)).max(100),
    accountScopes: z.array(accountIdSchema).max(100),
    brandScopes: z.array(brandIdSchema).max(100),
    version: z.number().int().positive(),
    status: z.enum(['active', 'revoked']),
  })
  .strict();

export const verifiedActorContextSchema = z
  .object({
    authoritySource: z.literal('verified_identity'),
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    accountScopes: z.array(accountIdSchema),
    brandScopes: z.array(brandIdSchema),
    grants: z.array(z.string().min(1)),
    membershipVersion: z.number().int().positive(),
    verifiedClaimsHash: sha256Schema,
    verifiedAt: timestampSchema,
  })
  .strict();

export type VerifiedActorContext = z.infer<typeof verifiedActorContextSchema>;

export const serverScopeSchema = z
  .object({
    derivation: z.literal('server_grants'),
    tenantId: tenantIdSchema,
    accountIds: z.array(accountIdSchema),
    brandIds: z.array(brandIdSchema),
    authorizationEpoch: z.number().int().positive(),
    scopeHash: sha256Schema,
  })
  .strict();

export type ServerScope = z.infer<typeof serverScopeSchema>;

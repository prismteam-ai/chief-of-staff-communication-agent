import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

import {
  accountIdSchema,
  brandIdSchema,
  positiveEpochSchema,
  sha256Schema,
  tenantIdSchema,
  userIdSchema,
} from '@chief/contracts';

import type {
  AuthorityMembershipResolution,
  AuthorityMembershipResolver,
  VerifiedSessionIdentity,
} from './request-authority.js';

const cognitoSubjectSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const grantNameSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/u);

const authorityGrantItemSchema = z
  .object({
    name: grantNameSchema,
    status: z.enum(['active', 'inactive', 'revoked']),
    scopeHash: sha256Schema,
    authorizationEpoch: positiveEpochSchema,
  })
  .strict();

export const authorityMembershipItemSchema = z
  .object({
    PK: z.string().min(1),
    SK: z.literal('AUTHORITY#MEMBERSHIP#v1'),
    schemaVersion: z.literal('chief-authority-membership.v1'),
    entityType: z.literal('authority-membership'),
    identityProvider: z.literal('cognito'),
    subject: cognitoSubjectSchema,
    status: z.enum(['active', 'inactive', 'revoked']),
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    accountScopes: z.array(accountIdSchema).max(100),
    brandScopes: z.array(brandIdSchema).max(100),
    grants: z.array(authorityGrantItemSchema).max(100),
    membershipVersion: positiveEpochSchema,
    authorizationEpoch: positiveEpochSchema,
    scopeHash: sha256Schema,
  })
  .strict()
  .superRefine((item, context) => {
    for (const [label, values] of [
      ['accountScopes', item.accountScopes],
      ['brandScopes', item.brandScopes],
      ['grants', item.grants.map(({ name }) => name)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          message: `${label} must not contain duplicates`,
          path: [label],
        });
      }
    }
  });

export type AuthorityMembershipItem = z.infer<
  typeof authorityMembershipItemSchema
>;

export interface DynamoMembershipReader {
  send(command: GetCommand): Promise<GetCommandOutput>;
}

export function authorityMembershipKey(
  verifiedCognitoSubject: string,
): Readonly<{ PK: string; SK: 'AUTHORITY#MEMBERSHIP#v1' }> {
  const subject = cognitoSubjectSchema.parse(verifiedCognitoSubject);
  return Object.freeze({
    PK: `AUTH#COGNITO#SUB#${Buffer.from(subject, 'utf8').toString('base64url')}`,
    SK: 'AUTHORITY#MEMBERSHIP#v1',
  });
}

function parseMembershipItem(
  item: Readonly<Record<string, unknown>>,
  identity: VerifiedSessionIdentity,
): AuthorityMembershipItem {
  const key = authorityMembershipKey(identity.subject);
  const parsed = authorityMembershipItemSchema.safeParse(item);
  if (
    !parsed.success ||
    parsed.data.PK !== key.PK ||
    parsed.data.SK !== key.SK ||
    parsed.data.subject !== identity.subject
  ) {
    throw new Error('INVALID_AUTHORITY_MEMBERSHIP_ITEM');
  }
  return parsed.data;
}

function resolution(
  item: AuthorityMembershipItem,
): AuthorityMembershipResolution {
  const activeMembership = item.status === 'active';
  return Object.freeze({
    status: activeMembership ? ('active' as const) : ('inactive' as const),
    tenantId: item.tenantId,
    userId: item.userId,
    accountScopes: Object.freeze([...item.accountScopes]),
    brandScopes: Object.freeze([...item.brandScopes]),
    grants: Object.freeze(
      item.grants.map((grant) =>
        Object.freeze({
          name: grant.name,
          status:
            activeMembership &&
            grant.status === 'active' &&
            grant.scopeHash === item.scopeHash &&
            grant.authorizationEpoch === item.authorizationEpoch
              ? ('active' as const)
              : ('inactive' as const),
        }),
      ),
    ),
    membershipVersion: item.membershipVersion,
    authorizationEpoch: item.authorizationEpoch,
    scopeHash: item.scopeHash,
  });
}

export function createDynamoAuthorityMembershipResolver(input: {
  readonly documentClient: DynamoMembershipReader;
  readonly tableName: string;
}): AuthorityMembershipResolver {
  const tableName = input.tableName.trim();
  if (tableName.length === 0) throw new Error('MISSING_AUTHORITY_TABLE_NAME');

  return {
    async resolveMembership(identity) {
      const key = authorityMembershipKey(identity.subject);
      const result = await input.documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (result.Item === undefined) return undefined;
      return resolution(parseMembershipItem(result.Item, identity));
    },
  };
}

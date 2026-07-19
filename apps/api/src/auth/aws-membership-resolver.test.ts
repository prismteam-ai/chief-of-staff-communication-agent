import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedSessionIdentity } from './request-authority.js';
import {
  authorityMembershipKey,
  createDynamoAuthorityMembershipResolver,
  type DynamoMembershipReader,
} from './aws-membership-resolver.js';

const subject = 'd6b37e5e-f27c-4fa5-bf62-61964d2ef654';
const scopeHash = 'a'.repeat(64);
const identity: VerifiedSessionIdentity = Object.freeze({
  subject,
  issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123',
  clientId: 'chief-client-id',
  tokenUse: 'access',
  issuedAt: 1_768_730_400,
  expiresAt: 1_768_734_000,
  tokenId: 'session-jti',
});

function membershipItem(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    ...authorityMembershipKey(subject),
    schemaVersion: 'chief-authority-membership.v1',
    entityType: 'authority-membership',
    identityProvider: 'cognito',
    subject,
    status: 'active',
    tenantId: 'tenant-server',
    userId: 'user-server',
    accountScopes: ['account-server'],
    brandScopes: ['brand-server'],
    grants: [
      {
        name: 'communications:read',
        status: 'active',
        scopeHash,
        authorizationEpoch: 3,
      },
    ],
    membershipVersion: 7,
    authorizationEpoch: 3,
    scopeHash,
    ...overrides,
  };
}

function grant(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    name: 'communications:read',
    status: 'active',
    scopeHash,
    authorizationEpoch: 3,
    ...overrides,
  };
}

function reader(item?: Readonly<Record<string, unknown>>): {
  readonly documentClient: DynamoMembershipReader;
  readonly send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn<(command: GetCommand) => Promise<GetCommandOutput>>(() =>
    Promise.resolve(
      item === undefined ? { $metadata: {} } : { $metadata: {}, Item: item },
    ),
  );
  return { documentClient: { send }, send };
}

describe('Dynamo authority membership resolver', () => {
  it('performs one strongly consistent exact-key read derived solely from verified subject', async () => {
    const fake = reader(membershipItem());
    const resolver = createDynamoAuthorityMembershipResolver({
      documentClient: fake.documentClient,
      tableName: 'chief-core',
    });

    await expect(resolver.resolveMembership(identity)).resolves.toMatchObject({
      status: 'active',
      tenantId: 'tenant-server',
      userId: 'user-server',
      accountScopes: ['account-server'],
      brandScopes: ['brand-server'],
      grants: [{ name: 'communications:read', status: 'active' }],
      membershipVersion: 7,
      authorizationEpoch: 3,
      scopeHash,
    });

    expect(fake.send).toHaveBeenCalledTimes(1);
    const command = fake.send.mock.calls[0]?.[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: 'chief-core',
      Key: authorityMembershipKey(subject),
      ConsistentRead: true,
    });
    expect(JSON.stringify(command.input)).not.toContain('tenant-server');
    expect(JSON.stringify(command.input)).not.toContain('account-server');
    expect(JSON.stringify(command.input)).not.toContain(identity.issuer);
    expect(JSON.stringify(command.input)).not.toContain(identity.clientId);
  });

  it('returns no authority when the subject has no membership item', async () => {
    const fake = reader();
    const resolver = createDynamoAuthorityMembershipResolver({
      documentClient: fake.documentClient,
      tableName: 'chief-core',
    });

    await expect(resolver.resolveMembership(identity)).resolves.toBeUndefined();
  });

  it.each(['inactive', 'revoked'] as const)(
    'maps an %s membership to inactive authority',
    async (status) => {
      const fake = reader(membershipItem({ status }));
      const resolver = createDynamoAuthorityMembershipResolver({
        documentClient: fake.documentClient,
        tableName: 'chief-core',
      });

      await expect(resolver.resolveMembership(identity)).resolves.toMatchObject(
        {
          status: 'inactive',
          grants: [{ name: 'communications:read', status: 'inactive' }],
        },
      );
    },
  );

  it.each([
    ['inactive', { status: 'inactive' as const }],
    ['revoked', { status: 'revoked' as const }],
    ['wrong scope', { scopeHash: 'b'.repeat(64) }],
    ['wrong epoch', { authorizationEpoch: 2 }],
  ])(
    'maps an %s grant to inactive authority',
    async (_label, grantOverride) => {
      const item = membershipItem({
        grants: [grant(grantOverride)],
      });
      const fake = reader(item);
      const resolver = createDynamoAuthorityMembershipResolver({
        documentClient: fake.documentClient,
        tableName: 'chief-core',
      });

      await expect(resolver.resolveMembership(identity)).resolves.toMatchObject(
        {
          status: 'active',
          grants: [{ name: 'communications:read', status: 'inactive' }],
        },
      );
    },
  );

  it.each([
    ['wrong subject', membershipItem({ subject: 'attacker-subject' })],
    ['wrong key', membershipItem({ PK: 'AUTH#COGNITO#SUB#attacker' })],
    ['invalid scope', membershipItem({ scopeHash: 'not-a-sha256' })],
    ['invalid epoch', membershipItem({ authorizationEpoch: 0 })],
  ])('fails closed for an item with %s', async (_label, item) => {
    const fake = reader(item);
    const resolver = createDynamoAuthorityMembershipResolver({
      documentClient: fake.documentClient,
      tableName: 'chief-core',
    });

    await expect(resolver.resolveMembership(identity)).rejects.toThrow(
      'INVALID_AUTHORITY_MEMBERSHIP_ITEM',
    );
  });
});

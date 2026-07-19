import { createSign, generateKeyPairSync } from 'node:crypto';

import type { Jwk, Jwks } from 'aws-jwt-verify/jwk';
import { describe, expect, it, vi } from 'vitest';

import {
  createCognitoSessionTokenVerifier,
  createRequestAuthorityResolver,
  type AuthorityMembershipResolution,
  type RequestAuthorityError,
  type VerifiedSessionIdentity,
} from './request-authority.js';

const userPoolId = 'us-east-2_AbCdEf123';
const issuer = `https://cognito-idp.us-east-2.amazonaws.com/${userPoolId}`;
const clientId = 'chief-client-id';
const kid = 'chief-test-key';
const nowSeconds = Math.floor(Date.now() / 1_000);
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const exportedJwk = publicKey.export({ format: 'jwk' });
const jwks: Jwks = {
  keys: [
    {
      ...exportedJwk,
      alg: 'RS256',
      kid,
      use: 'sig',
    } as Jwk,
  ],
};

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function accessToken(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const header = encode({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = encode({
    auth_time: nowSeconds - 30,
    client_id: clientId,
    exp: nowSeconds + 3_600,
    iat: nowSeconds - 30,
    iss: issuer,
    jti: 'session-jti',
    origin_jti: 'origin-jti',
    scope: 'openid',
    sub: 'cognito-subject',
    token_use: 'access',
    username: 'chief-user',
    version: 2,
    tenantId: 'caller-claimed-tenant',
    grants: ['caller:claimed'],
    ...overrides,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
}

const verifiedIdentity: VerifiedSessionIdentity = Object.freeze({
  subject: 'cognito-subject',
  issuer,
  clientId,
  tokenUse: 'access',
  issuedAt: nowSeconds - 30,
  expiresAt: nowSeconds + 3_600,
  tokenId: 'session-jti',
});

function membership(
  overrides: Partial<AuthorityMembershipResolution> = {},
): AuthorityMembershipResolution {
  return {
    status: 'active',
    tenantId: 'tenant-server',
    userId: 'user-server',
    accountScopes: ['account-server'],
    brandScopes: ['brand-server'],
    grants: [{ name: 'communications:read', status: 'active' }],
    membershipVersion: 7,
    authorizationEpoch: 3,
    scopeHash: 'a'.repeat(64),
    ...overrides,
  };
}

function expectAuthorityError(
  kind: 'unauthorized' | 'forbidden',
  reason: RequestAuthorityError['reason'],
): {
  readonly name: string;
  readonly kind: 'unauthorized' | 'forbidden';
  readonly reason: RequestAuthorityError['reason'];
} {
  return {
    name: 'RequestAuthorityError',
    kind,
    reason,
  };
}

describe('Cognito request authority', () => {
  const verifier = createCognitoSessionTokenVerifier({
    userPoolId,
    clientId,
    tokenUse: 'access',
    jwks,
  });

  it.each([
    ['expired', accessToken({ exp: nowSeconds - 1 })],
    ['malformed', 'not-a-jwt'],
    ['wrong issuer', accessToken({ iss: `${issuer}-attacker` })],
    ['wrong client', accessToken({ client_id: 'attacker-client' })],
  ])('rejects an %s token as unauthorized', async (_label, token) => {
    await expect(verifier.verify(token)).rejects.toMatchObject(
      expectAuthorityError('unauthorized', 'invalid_session'),
    );
  });

  it('derives authority only from the verified session and server membership', async () => {
    const resolveMembership = vi.fn(() => Promise.resolve(membership()));
    const resolver = createRequestAuthorityResolver({
      sessionVerifier: verifier,
      memberships: { resolveMembership },
      now: () => new Date('2026-07-19T10:00:00.000Z'),
    });

    const result = await resolver.resolve({
      headers: { authorization: `Bearer ${accessToken()}` },
    });

    expect(resolveMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'cognito-subject',
        issuer,
        clientId,
      }),
    );
    expect(result).toMatchObject({
      mode: 'verified-session',
      requestContext: {
        actor: {
          tenantId: 'tenant-server',
          userId: 'user-server',
          accountScopes: ['account-server'],
          brandScopes: ['brand-server'],
          grants: ['communications:read'],
          membershipVersion: 7,
          verifiedAt: '2026-07-19T10:00:00.000Z',
        },
        retrievalScope: {
          tenantId: 'tenant-server',
          accountIds: ['account-server'],
          brandIds: ['brand-server'],
          authorizationEpoch: 3,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('caller-claimed-tenant');
    expect(JSON.stringify(result)).not.toContain('caller:claimed');
    expect(JSON.stringify(result)).not.toContain(accessToken());
  });

  it.each([
    [undefined, 'inactive_membership'],
    [membership({ status: 'inactive' }), 'inactive_membership'],
    [
      membership({
        grants: [{ name: 'communications:read', status: 'inactive' }],
      }),
      'inactive_grant',
    ],
  ] as const)(
    'rejects inactive server membership or grants with forbidden',
    async (resolvedMembership, reason) => {
      const resolver = createRequestAuthorityResolver({
        sessionVerifier: {
          verify: () => Promise.resolve(verifiedIdentity),
        },
        memberships: {
          resolveMembership: () => Promise.resolve(resolvedMembership),
        },
      });

      await expect(
        resolver.resolve({ headers: { authorization: 'Bearer a.b.c' } }),
      ).rejects.toMatchObject(expectAuthorityError('forbidden', reason));
    },
  );

  it.each([
    [{}, 'authentication_required'],
    [{ authorization: 'Basic abc' }, 'invalid_session'],
    [{ authorization: 'Bearer malformed' }, 'invalid_session'],
  ])('rejects missing or malformed bearer input', async (headers, reason) => {
    const resolver = createRequestAuthorityResolver({
      sessionVerifier: {
        verify: () => Promise.resolve(verifiedIdentity),
      },
      memberships: {
        resolveMembership: () => Promise.resolve(membership()),
      },
    });

    await expect(resolver.resolve({ headers })).rejects.toMatchObject(
      expectAuthorityError(
        'unauthorized',
        reason as RequestAuthorityError['reason'],
      ),
    );
  });
});

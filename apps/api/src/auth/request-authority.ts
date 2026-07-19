import { createHash } from 'node:crypto';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Jwks } from 'aws-jwt-verify/jwk';

import { serverRequestContextSchema } from '@chief/contracts';

import type { ProductRequestContext } from '../product-service.js';

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export type RequestAuthMode = 'enforced' | 'local-test';

export interface RequestAuthorityInput {
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type ResolvedRequestAuthority =
  | {
      readonly mode: 'verified-session';
      readonly requestContext: ProductRequestContext;
    }
  | {
      readonly mode: 'local-test';
      readonly requestContext: ProductRequestContext;
    };

export interface RequestAuthorityResolver {
  resolve(input: RequestAuthorityInput): Promise<ResolvedRequestAuthority>;
}

export class RequestAuthorityError extends Error {
  public constructor(
    public readonly kind: 'unauthorized' | 'forbidden',
    public readonly reason:
      | 'authentication_required'
      | 'invalid_session'
      | 'inactive_membership'
      | 'inactive_grant',
  ) {
    super(
      kind === 'unauthorized'
        ? 'Authentication is required.'
        : 'The request is not permitted.',
    );
    this.name = 'RequestAuthorityError';
  }
}

export interface VerifiedSessionIdentity {
  readonly subject: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenUse: 'access' | 'id';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly tokenId: string;
}

export interface SessionTokenVerifier {
  verify(token: string): Promise<VerifiedSessionIdentity>;
}

export interface AuthorityGrantResolution {
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export interface AuthorityMembershipResolution {
  readonly status: 'active' | 'inactive';
  readonly tenantId: string;
  readonly userId: string;
  readonly accountScopes: readonly string[];
  readonly brandScopes: readonly string[];
  readonly grants: readonly AuthorityGrantResolution[];
  readonly membershipVersion: number;
  readonly authorizationEpoch: number;
  readonly scopeHash: string;
}

export interface AuthorityMembershipResolver {
  resolveMembership(
    identity: VerifiedSessionIdentity,
  ): Promise<AuthorityMembershipResolution | undefined>;
}

export interface CognitoSessionVerifierOptions {
  readonly userPoolId: string;
  readonly clientId: string | readonly string[];
  readonly tokenUse?: 'access' | 'id';
  /** Optional trusted preload for offline startup and deterministic verification. */
  readonly jwks?: Jwks;
}

function authorizationHeader(
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const entries = Object.entries(headers).filter(
    ([name]) => name.toLocaleLowerCase('en-US') === 'authorization',
  );
  if (entries.length > 1)
    throw new RequestAuthorityError('unauthorized', 'invalid_session');
  return entries[0]?.[1];
}

function bearerToken(
  headers: Readonly<Record<string, string | undefined>>,
): string {
  const header = authorizationHeader(headers);
  if (header === undefined || header.trim() === '')
    throw new RequestAuthorityError('unauthorized', 'authentication_required');
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  if (match === null || !JWT_SHAPE.test(match[1] as string))
    throw new RequestAuthorityError('unauthorized', 'invalid_session');
  return match[1] as string;
}

function claimsHash(identity: VerifiedSessionIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        clientId: identity.clientId,
        expiresAt: identity.expiresAt,
        issuedAt: identity.issuedAt,
        issuer: identity.issuer,
        subject: identity.subject,
        tokenId: identity.tokenId,
        tokenUse: identity.tokenUse,
      }),
      'utf8',
    )
    .digest('hex');
}

export function createCognitoSessionTokenVerifier(
  options: CognitoSessionVerifierOptions,
): SessionTokenVerifier {
  const tokenUse = options.tokenUse ?? 'access';
  const clientIds =
    typeof options.clientId === 'string'
      ? [options.clientId]
      : Array.from(options.clientId);
  const verifier = CognitoJwtVerifier.create({
    userPoolId: options.userPoolId,
    clientId: clientIds,
    tokenUse,
    includeRawJwtInErrors: false,
  });
  if (options.jwks !== undefined) verifier.cacheJwks(options.jwks);
  return {
    async verify(token) {
      try {
        const payload = await verifier.verify(token);
        const clientId =
          payload.token_use === 'access' ? payload.client_id : payload.aud;
        if (typeof clientId !== 'string')
          throw new RequestAuthorityError('unauthorized', 'invalid_session');
        return Object.freeze({
          subject: payload.sub,
          issuer: payload.iss,
          clientId,
          tokenUse: payload.token_use,
          issuedAt: payload.iat,
          expiresAt: payload.exp,
          tokenId: payload.jti,
        });
      } catch {
        throw new RequestAuthorityError('unauthorized', 'invalid_session');
      }
    },
  };
}

export function createRequestAuthorityResolver(input: {
  readonly sessionVerifier: SessionTokenVerifier;
  readonly memberships: AuthorityMembershipResolver;
  readonly now?: () => Date;
}): RequestAuthorityResolver {
  const now = input.now ?? (() => new Date());
  return {
    async resolve(request) {
      const identity = await input.sessionVerifier.verify(
        bearerToken(request.headers),
      );
      const membership = await input.memberships.resolveMembership(identity);
      if (membership === undefined || membership.status !== 'active')
        throw new RequestAuthorityError('forbidden', 'inactive_membership');
      const grants = membership.grants
        .filter(({ status }) => status === 'active')
        .map(({ name }) => name);
      if (grants.length === 0)
        throw new RequestAuthorityError('forbidden', 'inactive_grant');
      const requestContext = serverRequestContextSchema.parse({
        actor: {
          authoritySource: 'verified_identity',
          tenantId: membership.tenantId,
          userId: membership.userId,
          accountScopes: [...membership.accountScopes],
          brandScopes: [...membership.brandScopes],
          grants,
          membershipVersion: membership.membershipVersion,
          verifiedClaimsHash: claimsHash(identity),
          verifiedAt: now().toISOString(),
        },
        retrievalScope: {
          derivation: 'server_grants',
          tenantId: membership.tenantId,
          accountIds: [...membership.accountScopes],
          brandIds: [...membership.brandScopes],
          authorizationEpoch: membership.authorizationEpoch,
          scopeHash: membership.scopeHash,
        },
      });
      return Object.freeze({
        mode: 'verified-session' as const,
        requestContext,
      });
    },
  };
}

export function createCognitoRequestAuthorityResolver(input: {
  readonly userPoolId: string;
  readonly clientId: string | readonly string[];
  readonly tokenUse?: 'access' | 'id';
  readonly memberships: AuthorityMembershipResolver;
  readonly now?: () => Date;
}): RequestAuthorityResolver {
  return createRequestAuthorityResolver({
    sessionVerifier: createCognitoSessionTokenVerifier(input),
    memberships: input.memberships,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export function createLocalTestRequestAuthorityResolver(
  requestContext: ProductRequestContext,
): RequestAuthorityResolver {
  const safeContext = serverRequestContextSchema.parse(requestContext);
  return {
    resolve: () =>
      Promise.resolve(
        Object.freeze({
          mode: 'local-test' as const,
          requestContext: safeContext,
        }),
      ),
  };
}

export function createDenyAllRequestAuthorityResolver(): RequestAuthorityResolver {
  return {
    resolve: ({ headers }) => {
      bearerToken(headers);
      return Promise.reject(
        new RequestAuthorityError('unauthorized', 'invalid_session'),
      );
    },
  };
}

export function requestAuthorityInput(
  event: APIGatewayProxyEventV2,
): RequestAuthorityInput {
  return { headers: event.headers };
}

import { createHash } from 'node:crypto';

import type {
  AuthorizationCallback,
  AuthorizationInput,
  AuthorizationStart,
} from '@chief/contracts/connectors';

export const GRAPH_PERSONAL_ACCOUNT_AUTHORITY =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const GRAPH_AUTHORIZATION_AUDIENCE = 'https://graph.microsoft.com/';
export const GRAPH_DELEGATED_SCOPES = Object.freeze([
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.Send',
] as const);

export interface GraphOAuthConfiguration {
  readonly clientId: string;
  readonly authority?: string;
  readonly authorizationTtlSeconds?: number;
}

export interface GraphOAuthTransaction {
  readonly tenantId: string;
  readonly userId: string;
  readonly stateDigest: string;
  readonly redirectUri: string;
  readonly pkceChallenge: string;
  readonly expiresAt: string;
}

export function assertExactGraphScopes(scopes: readonly string[]): void {
  if (
    scopes.length !== GRAPH_DELEGATED_SCOPES.length ||
    scopes.some((scope, index) => scope !== GRAPH_DELEGATED_SCOPES[index])
  ) {
    throw new Error('GRAPH_SCOPE_SET_MISMATCH');
  }
}

export function buildGraphAuthorizationStart(
  input: AuthorizationInput,
  configuration: GraphOAuthConfiguration,
  now: Date,
): AuthorizationStart {
  if (input.connectorId !== 'microsoft-graph') {
    throw new Error('GRAPH_CONNECTOR_BINDING_MISMATCH');
  }
  assertExactGraphScopes(input.requestedScopes);
  if (
    input.redirectUri.startsWith('http://') &&
    !isLoopback(input.redirectUri)
  ) {
    throw new Error('GRAPH_REDIRECT_REQUIRES_HTTPS_OR_LOOPBACK');
  }
  const authority = configuration.authority ?? GRAPH_PERSONAL_ACCOUNT_AUTHORITY;
  if (authority !== GRAPH_PERSONAL_ACCOUNT_AUTHORITY) {
    throw new Error('GRAPH_AUTHORITY_NOT_PERSONAL_ACCOUNT_CAPABLE');
  }
  const url = new URL(`${authority}/authorize`);
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', input.requestedScopes.join(' '));
  url.searchParams.set('state', input.stateDigest);
  url.searchParams.set('code_challenge', input.pkceChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    authorizationUrl: url.toString(),
    stateDigest: input.stateDigest,
    expiresAt: new Date(
      now.getTime() + (configuration.authorizationTtlSeconds ?? 600) * 1_000,
    ).toISOString(),
  };
}

export function derivePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export function validateGraphAuthorizationCallback(
  callback: AuthorizationCallback,
  transaction: GraphOAuthTransaction,
  now: Date,
): void {
  if (
    callback.tenantId !== transaction.tenantId ||
    callback.userId !== transaction.userId ||
    callback.stateDigest !== transaction.stateDigest ||
    callback.callbackUri !== transaction.redirectUri
  ) {
    throw new Error('GRAPH_OAUTH_TRANSACTION_BINDING_MISMATCH');
  }
  if (Date.parse(transaction.expiresAt) <= now.getTime()) {
    throw new Error('GRAPH_OAUTH_TRANSACTION_EXPIRED');
  }
  if (
    derivePkceChallenge(callback.pkceVerifier) !== transaction.pkceChallenge
  ) {
    throw new Error('GRAPH_PKCE_VERIFIER_MISMATCH');
  }
}

function isLoopback(uri: string): boolean {
  const parsed = new URL(uri);
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === 'localhost')
  );
}

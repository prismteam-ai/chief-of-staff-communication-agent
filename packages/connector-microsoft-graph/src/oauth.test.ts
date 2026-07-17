import { describe, expect, it } from 'vitest';
import {
  authorizationCallbackSchema,
  authorizationInputSchema,
} from '@chief/contracts/connectors';

import {
  GRAPH_DELEGATED_SCOPES,
  GRAPH_PERSONAL_ACCOUNT_AUTHORITY,
  buildGraphAuthorizationStart,
  derivePkceChallenge,
  validateGraphAuthorizationCallback,
} from './oauth.js';

const HASH = 'a'.repeat(64);
const VERIFIER = 'v'.repeat(43);

function authorizationInput(redirectUri = 'http://127.0.0.1:38421/callback') {
  return authorizationInputSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-a',
    userId: 'user-a',
    connectorId: 'microsoft-graph',
    redirectUri,
    stateDigest: HASH,
    pkceChallenge: derivePkceChallenge(VERIFIER),
    requestedScopes: [...GRAPH_DELEGATED_SCOPES],
  });
}

describe('Microsoft Graph personal-account OAuth contract', () => {
  it('builds authorization-code plus S256 PKCE with the exact delegated scopes', () => {
    const result = buildGraphAuthorizationStart(
      authorizationInput(),
      { clientId: 'personal-account-client' },
      new Date('2026-07-17T12:00:00.000Z'),
    );
    const url = new URL(result.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${GRAPH_PERSONAL_ACCOUNT_AUTHORITY}/authorize`,
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(
      GRAPH_DELEGATED_SCOPES.join(' '),
    );
    expect(url.searchParams.get('state')).toBe(HASH);
  });

  it('rejects scope expansion and non-loopback plaintext redirects', () => {
    expect(() =>
      buildGraphAuthorizationStart(
        {
          ...authorizationInput(),
          requestedScopes: [...GRAPH_DELEGATED_SCOPES, 'Mail.ReadWrite'],
        },
        { clientId: 'personal-account-client' },
        new Date('2026-07-17T12:00:00.000Z'),
      ),
    ).toThrow('GRAPH_SCOPE_SET_MISMATCH');
    expect(() =>
      buildGraphAuthorizationStart(
        authorizationInput('http://example.invalid/callback'),
        { clientId: 'personal-account-client' },
        new Date('2026-07-17T12:00:00.000Z'),
      ),
    ).toThrow('GRAPH_REDIRECT_REQUIRES_HTTPS_OR_LOOPBACK');
  });

  it('binds callback state, user, redirect, expiry, and PKCE verifier', () => {
    const input = authorizationInput();
    const callback = authorizationCallbackSchema.parse({
      schemaVersion: '1',
      tenantId: input.tenantId,
      userId: input.userId,
      stateDigest: input.stateDigest,
      code: 'authorization-code-fixture',
      pkceVerifier: VERIFIER,
      callbackUri: input.redirectUri,
    });
    expect(() =>
      validateGraphAuthorizationCallback(
        callback,
        {
          tenantId: input.tenantId,
          userId: input.userId,
          stateDigest: input.stateDigest,
          redirectUri: input.redirectUri,
          pkceChallenge: input.pkceChallenge,
          expiresAt: '2026-07-17T12:10:00.000Z',
        },
        new Date('2026-07-17T12:05:00.000Z'),
      ),
    ).not.toThrow();
    expect(() =>
      validateGraphAuthorizationCallback(
        callback,
        {
          tenantId: input.tenantId,
          userId: input.userId,
          stateDigest: input.stateDigest,
          redirectUri: input.redirectUri,
          pkceChallenge: derivePkceChallenge('x'.repeat(43)),
          expiresAt: '2026-07-17T12:10:00.000Z',
        },
        new Date('2026-07-17T12:05:00.000Z'),
      ),
    ).toThrow('GRAPH_PKCE_VERIFIER_MISMATCH');
  });
});

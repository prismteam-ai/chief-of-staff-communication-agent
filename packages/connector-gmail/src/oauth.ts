import type {
  AuthorizationInput,
  AuthorizationStart,
} from '@chief/contracts/connectors';

import { GMAIL_CONNECTOR_ID, GMAIL_OAUTH_SCOPES } from './descriptor.js';

export { GMAIL_OAUTH_SCOPES } from './descriptor.js';

function sameScopes(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((scope, index) => scope === rightSorted[index])
  );
}

export function beginGmailAuthorization(input: {
  readonly request: AuthorizationInput;
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly expiresAt: string;
}): AuthorizationStart {
  if (input.request.connectorId !== GMAIL_CONNECTOR_ID) {
    throw new Error('GMAIL_OAUTH_CONNECTOR_MISMATCH');
  }
  if (!sameScopes(input.request.requestedScopes, GMAIL_OAUTH_SCOPES)) {
    throw new Error('GMAIL_OAUTH_SCOPE_SET_REJECTED');
  }
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.request.redirectUri);
  url.searchParams.set('scope', GMAIL_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', input.request.stateDigest);
  url.searchParams.set('code_challenge', input.request.pkceChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  return {
    authorizationUrl: url.toString(),
    stateDigest: input.request.stateDigest,
    expiresAt: input.expiresAt,
  };
}

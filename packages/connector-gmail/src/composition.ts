import type { GmailConnectorDependencies } from './types.js';
import { GmailConnector } from './connector.js';
import {
  GoogleApisGmailClient,
  type GmailAccountSnapshotResolver,
  type GmailApiEvidenceBoundary,
  type GmailPreparedMimeSource,
} from './googleapis-client.js';

export interface GoogleApisGmailCompositionInput {
  readonly gmail: ConstructorParameters<typeof GoogleApisGmailClient>[0];
  readonly evidence: GmailApiEvidenceBoundary;
  readonly preparedMime: GmailPreparedMimeSource;
  readonly snapshots: GmailAccountSnapshotResolver;
  readonly oauth: GmailConnectorDependencies['oauth'];
  readonly cursorCodec: GmailConnectorDependencies['cursorCodec'];
  readonly oauthClientId: string;
  readonly authorizationEndpoint?: string;
  readonly authorizationTtlSeconds?: number;
  readonly now?: () => string;
}

/**
 * Wires the real googleapis transport to the canonical Gmail connector.
 * Credential storage, OAuth completion, evidence persistence, MIME storage,
 * and cursor protection stay explicit injected production boundaries.
 */
export function createGoogleApisGmailConnector(
  input: GoogleApisGmailCompositionInput,
): {
  readonly client: GoogleApisGmailClient;
  readonly connector: GmailConnector;
} {
  const client = new GoogleApisGmailClient(
    input.gmail,
    input.evidence,
    input.preparedMime,
    input.snapshots,
    input.now,
  );
  return {
    client,
    connector: new GmailConnector({
      history: client,
      send: client,
      oauth: input.oauth,
      cursorCodec: input.cursorCodec,
      oauthClientId: input.oauthClientId,
      ...(input.authorizationEndpoint === undefined
        ? {}
        : { authorizationEndpoint: input.authorizationEndpoint }),
      ...(input.authorizationTtlSeconds === undefined
        ? {}
        : { authorizationTtlSeconds: input.authorizationTtlSeconds }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  };
}

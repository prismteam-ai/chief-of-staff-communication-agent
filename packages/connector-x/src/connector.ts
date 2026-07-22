import { assertCheckpointFence } from '@chief/connector-core';
import type {
  ExternalCommunicationConnector,
  OAuthCommunicationConnector,
} from '@chief/connector-core';
import type {
  ConnectorAccount,
  ConnectorAccountRef,
  PollRequest,
  ProviderMessageRef,
  ProviderThreadRef,
  VerifiedProviderEvent,
} from '@chief/contracts/connectors';
import type { ConnectorContractFixtures } from '@chief/connector-testkit';

import { createXProviderFixtures } from './contract-fixtures.js';
import {
  normalizeLegacyDmPollPage,
  parseLegacyDmLookupResponse,
} from './legacy-dm.js';
import {
  X_LEGACY_DM_SCOPES,
  X_OAUTH_AUDIENCE,
  xChatEncryptedDescriptor,
  xLegacyDmDescriptor,
} from './implementation-metadata.js';
import {
  LEGACY_DM_LOOKUP_FIXTURE_JSON,
  parseFixtureJson,
} from './provider-fixtures.js';

const OBSERVED_AT = '2026-07-17T12:00:00.000Z';
const PROVIDER_RESPONSE_HASH = 'd'.repeat(64);
const CANONICAL_PAYLOAD_HASH = 'e'.repeat(64);

export const xLegacyDmFixtures = createXProviderFixtures({
  descriptor: xLegacyDmDescriptor,
  runtimeMode: 'fixture',
  selectionState: 'selected',
});

export const xChatEncryptedFixtures = createXProviderFixtures({
  descriptor: xChatEncryptedDescriptor,
  runtimeMode: 'blocked_external_access',
  selectionState: 'not_applicable',
});

function sameAccount(
  left: ConnectorAccountRef,
  right: ConnectorAccountRef,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.accountId === right.accountId &&
    left.expectedStateVersion === right.expectedStateVersion
  );
}

function accountRef(account: ConnectorAccount): ConnectorAccountRef {
  return {
    tenantId: account.tenantId,
    accountId: account.accountId,
    expectedStateVersion: account.stateVersion,
  };
}

function assertLegacyAccount(
  account: ConnectorAccountRef,
  fixtures: ConnectorContractFixtures,
): void {
  if (!sameAccount(account, fixtures.accountRef)) {
    throw new Error('X_ACCOUNT_SCOPE_MISMATCH');
  }
}

const lookupFixture = parseLegacyDmLookupResponse(
  parseFixtureJson(LEGACY_DM_LOOKUP_FIXTURE_JSON),
);

function legacyEnvelope(
  account: ConnectorAccountRef,
  event: (typeof lookupFixture.data)[number],
  fixtures: ConnectorContractFixtures,
  refOverride?: ProviderMessageRef,
) {
  return {
    schemaVersion: '1' as const,
    account,
    providerMessageRef: refOverride ?? {
      providerMessageId: event.id,
      providerThreadId: event.dm_conversation_id,
    },
    sourceTimestamp: event.created_at,
    rawBodyRef: `fixture://x/legacy-dm/${event.id}`,
    canonicalPayloadHash: CANONICAL_PAYLOAD_HASH,
    attachmentCount: event.attachments?.length ?? 0,
    connectorSnapshot: fixtures.snapshot,
  };
}

export function createXLegacyDmFixtureConnector(
  fixtures: ConnectorContractFixtures = xLegacyDmFixtures,
): OAuthCommunicationConnector {
  return {
    connectorKind: 'communication',
    descriptor: () => xLegacyDmDescriptor,
    authorizationStrategy: () => ({
      strategy: 'oauth',
      audience: X_OAUTH_AUDIENCE,
      scopes: [...X_LEGACY_DM_SCOPES],
    }),
    beginAuthorization: (input) => {
      if (input.connectorId !== xLegacyDmDescriptor.connectorId) {
        throw new Error('X_OAUTH_CONNECTOR_MISMATCH');
      }
      if (
        [...input.requestedScopes].sort().join('\u0000') !==
        [...X_LEGACY_DM_SCOPES].sort().join('\u0000')
      ) {
        throw new Error('X_OAUTH_SCOPE_MISMATCH');
      }
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: 'effect-disabled-fixture-client',
        redirect_uri: input.redirectUri,
        scope: X_LEGACY_DM_SCOPES.join(' '),
        state: input.stateDigest,
        code_challenge: input.pkceChallenge,
        code_challenge_method: 'S256',
      });
      return Promise.resolve({
        authorizationUrl: `https://x.com/i/oauth2/authorize?${query.toString()}`,
        stateDigest: input.stateDigest,
        expiresAt: '2026-07-17T12:10:00.000Z',
      });
    },
    completeAuthorization: () =>
      Promise.reject(new Error('X_OAUTH_TOKEN_EXCHANGE_DISABLED')),
    validateConnection: (account) =>
      Promise.resolve({
        account,
        health: 'failed',
        observedAt: OBSERVED_AT,
        capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
        errorCode: 'X_EXTERNAL_ACCESS_DISABLED',
      }),
    poll: (account, request: PollRequest) =>
      Promise.resolve().then(() => {
        assertLegacyAccount(account, fixtures);
        assertCheckpointFence(request);
        const page = normalizeLegacyDmPollPage({
          request,
          response: lookupFixture,
          budget: {
            remainingRequests: 1,
            remainingResources: 100,
            remainingCostUsd: 1,
            readResourceUnitCostUsd: 0.01,
          },
          now: '2026-07-17T12:00:00.000Z',
        });
        return {
          envelopes: page.events.map((event) =>
            legacyEnvelope(account, event, fixtures),
          ),
          ...(page.nextCursor === undefined
            ? {}
            : { nextEncryptedCursor: page.nextCursor }),
          sourceWatermark:
            page.events.at(-1)?.id ?? request.checkpoint.sourceWatermark,
          complete: page.nextCursor === undefined,
          providerResponseHash: PROVIDER_RESPONSE_HASH,
        };
      }),
    fetchMessage: (account: ConnectorAccount, ref: ProviderMessageRef) =>
      Promise.resolve().then(() => {
        const refAccount = accountRef(account);
        assertLegacyAccount(refAccount, fixtures);
        const event =
          lookupFixture.data.find(
            (candidate) => candidate.id === ref.providerMessageId,
          ) ??
          (ref.providerMessageId === 'provider-message-a'
            ? lookupFixture.data[0]
            : undefined);
        if (event === undefined) {
          throw new Error('X_DM_EVENT_NOT_FOUND');
        }
        return legacyEnvelope(refAccount, event, fixtures, ref);
      }),
    fetchThread: (account: ConnectorAccount, ref: ProviderThreadRef) =>
      Promise.resolve().then(() => {
        const refAccount = accountRef(account);
        assertLegacyAccount(refAccount, fixtures);
        const seen = new Set<string>();
        const matching = lookupFixture.data
          .filter((event) => event.dm_conversation_id === ref.providerThreadId)
          .filter((event) => {
            if (seen.has(event.id)) return false;
            seen.add(event.id);
            return true;
          })
          .map((event) => legacyEnvelope(refAccount, event, fixtures));
        if (matching.length > 0) return matching;
        const first = lookupFixture.data[0];
        return first === undefined
          ? []
          : [
              legacyEnvelope(refAccount, first, fixtures, {
                providerMessageId: first.id,
                providerThreadId: ref.providerThreadId,
              }),
            ];
      }),
    normalizeInboundEvent: (event: VerifiedProviderEvent) => ({
      schemaVersion: '1',
      verifiedEvent: event,
      providerMessageId: lookupFixture.data[0]?.id ?? 'fixture-missing',
      providerThreadId:
        lookupFixture.data[0]?.dm_conversation_id ?? 'fixture-missing',
      sourceTimestamp: lookupFixture.data[0]?.created_at ?? OBSERVED_AT,
      canonicalPayloadHash: CANONICAL_PAYLOAD_HASH,
    }),
  };
}

export const xLegacyDmFixtureConnector = createXLegacyDmFixtureConnector();

export function createXChatEncryptedBlockedConnector(
  fixtures: ConnectorContractFixtures = xChatEncryptedFixtures,
): ExternalCommunicationConnector {
  return {
    connectorKind: 'communication',
    descriptor: () => xChatEncryptedDescriptor,
    authorizationStrategy: () => ({ strategy: 'external' }),
    validateConnection: (account) =>
      Promise.resolve({
        account,
        health: 'failed',
        observedAt: OBSERVED_AT,
        capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
        errorCode: 'XCHAT_ENTITLEMENT_UNPROVEN',
      }),
  };
}

export const xChatEncryptedBlockedConnector =
  createXChatEncryptedBlockedConnector();

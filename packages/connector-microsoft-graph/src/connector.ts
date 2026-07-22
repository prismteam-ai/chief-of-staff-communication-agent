import type { OAuthCommunicationConnector } from '@chief/connector-core';
import type {
  AuthorizationCallback,
  AuthorizationInput,
  ConnectorAccount,
  ConnectorAccountRef,
  PollRequest,
  ProviderMessageRef,
  ProviderThreadRef,
  RawWebhookRequest,
  SubscriptionMutationRequest,
  VerifiedProviderEvent,
  WebhookVerification,
} from '@chief/contracts/connectors';

import type { GraphDeltaResponse, GraphMessage } from './graph-types.js';
import { microsoftGraphFixtureDescriptor } from './implementation-metadata.js';
import { pollGraphDelta, type GraphDeltaTransport } from './delta.js';
import {
  GRAPH_AUTHORIZATION_AUDIENCE,
  GRAPH_DELEGATED_SCOPES,
  buildGraphAuthorizationStart,
  validateGraphAuthorizationCallback,
  type GraphOAuthTransaction,
} from './oauth.js';
import { inspectGraphNotificationRequest } from './notifications.js';
import { normalizeGraphMessage } from './normalization.js';
import {
  GRAPH_FIXTURE_CLIENT_STATE,
  GRAPH_FIXTURE_LATER,
  GRAPH_FIXTURE_NOW,
  graphDeltaFixture,
  graphMessageFixture,
} from './recorded-fixtures.js';
import {
  dispatchGraphPreboundDraft,
  reconcileGraphPreboundDraft,
  type GraphDraftTransport,
} from './send.js';

const FIXTURE_HASH = 'a'.repeat(64);

export interface MicrosoftGraphFixtureConnectorOptions {
  readonly account: ConnectorAccount;
  readonly messages?: readonly GraphMessage[];
  readonly deltaResponse?: GraphDeltaResponse;
  readonly expectedClientState?: string;
  readonly draftTransport?: GraphDraftTransport;
  readonly oauthTransaction?: GraphOAuthTransaction;
}

export function createMicrosoftGraphFixtureConnector(
  options: MicrosoftGraphFixtureConnectorOptions,
): OAuthCommunicationConnector {
  const messages = options.messages ?? [graphMessageFixture];
  const expectedClientState =
    options.expectedClientState ?? GRAPH_FIXTURE_CLIENT_STATE;
  const deltaTransport: GraphDeltaTransport = {
    poll: () =>
      Promise.resolve({
        response: options.deltaResponse ?? graphDeltaFixture,
        nextSealedCursor: 'sealed:graph-delta-terminal',
      }),
  };
  const draftTransport = options.draftTransport ?? fixtureDraftTransport;
  const accountRef: ConnectorAccountRef = {
    tenantId: options.account.tenantId,
    accountId: options.account.accountId,
    expectedStateVersion: options.account.stateVersion,
  };
  const normalize = (message: GraphMessage) =>
    normalizeGraphMessage(message, {
      account: accountRef,
      snapshot: options.account.snapshot,
      rawBodyRef: `fixture://microsoft-graph/messages/${message.id}`,
    });
  return {
    connectorKind: 'communication',
    descriptor: () => microsoftGraphFixtureDescriptor,
    authorizationStrategy: () => ({
      strategy: 'oauth',
      audience: GRAPH_AUTHORIZATION_AUDIENCE,
      scopes: [...GRAPH_DELEGATED_SCOPES],
    }),
    beginAuthorization: (input: AuthorizationInput) =>
      Promise.resolve(
        buildGraphAuthorizationStart(
          input,
          { clientId: 'fixture-personal-account-client' },
          new Date(GRAPH_FIXTURE_NOW),
        ),
      ),
    completeAuthorization: (callback: AuthorizationCallback) => {
      if (options.oauthTransaction === undefined) {
        return Promise.reject(
          new Error('GRAPH_OAUTH_TRANSACTION_NOT_PREPARED'),
        );
      }
      validateGraphAuthorizationCallback(
        callback,
        options.oauthTransaction,
        new Date(GRAPH_FIXTURE_NOW),
      );
      if (
        callback.tenantId !== options.account.tenantId ||
        callback.userId !== options.account.ownerUserId
      ) {
        return Promise.reject(
          new Error('GRAPH_OAUTH_ACCOUNT_BINDING_MISMATCH'),
        );
      }
      return Promise.resolve(options.account);
    },
    validateConnection: (requestedAccount: ConnectorAccountRef) =>
      Promise.resolve().then(() => {
        assertAccountRef(requestedAccount, accountRef);
        return {
          account: requestedAccount,
          health: 'healthy' as const,
          observedAt: GRAPH_FIXTURE_NOW,
          capabilitySnapshotHash:
            options.account.snapshot.capabilitySnapshotHash,
        };
      }),
    subscribe: (_account, request) =>
      Promise.resolve(subscriptionFixture(request, 'created')),
    renewSubscription: (_account, request) =>
      Promise.resolve(subscriptionFixture(request, 'renewed')),
    poll: (_account: ConnectorAccountRef, request: PollRequest) =>
      pollGraphDelta(deltaTransport, request, {
        account: accountRef,
        snapshot: options.account.snapshot,
        rawBodyRef: 'fixture://microsoft-graph/delta/page-1',
      }),
    fetchMessage: (_account, ref: ProviderMessageRef) => {
      const message = messages.find(
        (candidate) => candidate.id === ref.providerMessageId,
      );
      if (message === undefined) {
        return Promise.reject(new Error('GRAPH_MESSAGE_NOT_FOUND'));
      }
      const envelope = normalize(message).envelope;
      return Promise.resolve(
        ref.providerThreadId === undefined
          ? {
              ...envelope,
              providerMessageRef: {
                providerMessageId:
                  envelope.providerMessageRef.providerMessageId,
              },
            }
          : envelope,
      );
    },
    fetchThread: (_account, ref: ProviderThreadRef) =>
      Promise.resolve(
        messages
          .filter((message) => message.conversationId === ref.providerThreadId)
          .map((message) => normalize(message).envelope),
      ),
    send: (_account, artifact) =>
      dispatchGraphPreboundDraft(artifact, draftTransport),
    reconcileSend: (_account, request) =>
      reconcileGraphPreboundDraft(request, draftTransport),
    verifyWebhook: (request: RawWebhookRequest): WebhookVerification => {
      const inspected = inspectGraphNotificationRequest(
        request,
        expectedClientState,
      );
      return inspected.kind === 'notifications'
        ? inspected.verification
        : {
            verified: false,
            reasonCode: 'graph_validation_challenge_not_event',
          };
    },
    normalizeInboundEvent: (event: VerifiedProviderEvent) => ({
      schemaVersion: '1',
      verifiedEvent: event,
      providerMessageId: messages[0]?.id ?? 'graph-message-unavailable',
      providerThreadId: messages[0]?.conversationId,
      sourceTimestamp:
        messages[0]?.receivedDateTime ??
        messages[0]?.lastModifiedDateTime ??
        GRAPH_FIXTURE_NOW,
      canonicalPayloadHash: normalize(messages[0] ?? graphMessageFixture)
        .message.canonicalPayloadHash,
    }),
  };
}

function assertAccountRef(
  actual: ConnectorAccountRef,
  expected: ConnectorAccountRef,
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.accountId !== expected.accountId ||
    actual.expectedStateVersion !== expected.expectedStateVersion
  ) {
    throw new Error('GRAPH_ACCOUNT_BINDING_MISMATCH');
  }
}

function subscriptionFixture(
  request: SubscriptionMutationRequest,
  operation: 'created' | 'renewed',
) {
  if (
    request.hostedCallbackReleaseHash === undefined ||
    request.hostedCallbackDeploymentHash === undefined
  ) {
    throw new Error('GRAPH_HOSTED_CALLBACK_PROOF_REQUIRED');
  }
  return {
    providerReference: `fixture-subscription-${operation}`,
    providerResponseHash: FIXTURE_HASH,
    expiresAt: request.requestedExpiresAt,
    renewAfter: GRAPH_FIXTURE_LATER,
    observedAt: GRAPH_FIXTURE_NOW,
  };
}

const fixtureDraftTransport: GraphDraftTransport = {
  sendPreboundDraft: () =>
    Promise.resolve({
      status: 202,
      requestId: 'graph-request-fixture-a',
      observedAt: GRAPH_FIXTURE_LATER,
    }),
  findSentItem: ({ immutableDraftId }) =>
    Promise.resolve({
      immutableDraftId,
      immutableMessageId: 'graph-sent-immutable-a',
      observedAt: GRAPH_FIXTURE_LATER,
    }),
};

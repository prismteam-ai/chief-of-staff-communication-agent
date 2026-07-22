import {
  canonicalEnvelopeSchema,
  normalizedInboundEventSchema,
  syncPageSchema,
  webhookVerificationSchema,
} from '@chief/contracts/connectors';
import type {
  EffectExecutionArtifact,
  FeedbackContext,
  FeedbackParseResult,
  ProviderSendResult,
  ReconcileSendRequest,
} from '@chief/contracts/approval';
import type {
  AuthorizationCallback,
  AuthorizationInput,
  AuthorizationStart,
  CanonicalEnvelope,
  ConnectionHealth,
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorDescriptor,
  CredentialConnectionInput,
  NormalizedInboundEvent,
  PollRequest,
  ProviderMessageRef,
  ProviderSubscriptionResult,
  ProviderThreadRef,
  RawWebhookRequest,
  SubscriptionMutationRequest,
  SyncPage,
  VerifiedProviderEvent,
  WebhookVerification,
} from '@chief/contracts/connectors';

import type { AuthorizationStrategyDescriptor } from './authorization.js';
import { assertCheckpointFence } from './checkpoint.js';

interface CommunicationConnectorCommon {
  readonly connectorKind: 'communication';
  descriptor(): ConnectorDescriptor;
  authorizationStrategy(): AuthorizationStrategyDescriptor;
  validateConnection(account: ConnectorAccountRef): Promise<ConnectionHealth>;
  subscribe?(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult>;
  renewSubscription?(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult>;
  poll?(account: ConnectorAccountRef, request: PollRequest): Promise<SyncPage>;
  fetchMessage?(
    account: ConnectorAccount,
    ref: ProviderMessageRef,
  ): Promise<CanonicalEnvelope>;
  fetchThread?(
    account: ConnectorAccount,
    ref: ProviderThreadRef,
  ): Promise<readonly CanonicalEnvelope[]>;
  send?(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<ProviderSendResult>;
  reconcileSend?(
    account: ConnectorAccountRef,
    request: ReconcileSendRequest,
  ): Promise<ProviderSendResult>;
  verifyWebhook?(request: RawWebhookRequest): WebhookVerification;
  normalizeInboundEvent?(event: VerifiedProviderEvent): NormalizedInboundEvent;
  parseFeedbackEvent?(
    event: VerifiedProviderEvent,
    context: FeedbackContext,
  ): FeedbackParseResult;
}

export interface OAuthCommunicationConnector extends CommunicationConnectorCommon {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'oauth' }
  >;
  beginAuthorization(input: AuthorizationInput): Promise<AuthorizationStart>;
  completeAuthorization(
    input: AuthorizationCallback,
  ): Promise<ConnectorAccount>;
  configureCredentialConnection?: never;
}

export interface CredentialCommunicationConnector extends CommunicationConnectorCommon {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'credential' }
  >;
  configureCredentialConnection(
    input: CredentialConnectionInput,
  ): Promise<ConnectorAccount>;
  beginAuthorization?: never;
  completeAuthorization?: never;
}

export interface ExternalCommunicationConnector extends CommunicationConnectorCommon {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'external' }
  >;
  beginAuthorization?: never;
  completeAuthorization?: never;
  configureCredentialConnection?: never;
}

export interface NoAuthorizationCommunicationConnector extends CommunicationConnectorCommon {
  authorizationStrategy(): Extract<
    AuthorizationStrategyDescriptor,
    { readonly strategy: 'none' }
  >;
  beginAuthorization?: never;
  completeAuthorization?: never;
  configureCredentialConnection?: never;
}

export type CommunicationConnector =
  | OAuthCommunicationConnector
  | CredentialCommunicationConnector
  | ExternalCommunicationConnector
  | NoAuthorizationCommunicationConnector;

export interface VerifiedEventPersistence {
  persistVerifiedEvent(
    request: RawWebhookRequest,
    verification: Extract<WebhookVerification, { readonly verified: true }>,
  ): Promise<VerifiedProviderEvent>;
}

export type WebhookNormalizationResult =
  | { readonly status: 'rejected'; readonly reasonCode: string }
  | { readonly status: 'normalized'; readonly event: NormalizedInboundEvent };

function sameAccountRef(
  left: ConnectorAccountRef,
  right: ConnectorAccountRef,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.accountId === right.accountId &&
    left.expectedStateVersion === right.expectedStateVersion
  );
}

function sameSnapshot(
  left: ConnectorAccount['snapshot'],
  right: ConnectorAccount['snapshot'],
): boolean {
  return (
    left.connectorId === right.connectorId &&
    left.descriptorVersion === right.descriptorVersion &&
    left.accountId === right.accountId &&
    left.capabilitySnapshotHash === right.capabilitySnapshotHash &&
    left.runtimeMode === right.runtimeMode &&
    left.selectionState === right.selectionState
  );
}

function assertEnvelopeBinding(
  envelope: CanonicalEnvelope,
  account: ConnectorAccountRef,
  snapshot: ConnectorAccount['snapshot'],
): void {
  if (
    !sameAccountRef(envelope.account, account) ||
    !sameSnapshot(envelope.connectorSnapshot, snapshot)
  ) {
    throw new Error('PROVIDER_FACT_BINDING_MISMATCH');
  }
}

export async function pollCommunicationConnector(
  connector: CommunicationConnector,
  account: ConnectorAccountRef,
  request: PollRequest,
): Promise<SyncPage> {
  if (
    !connector.descriptor().capabilities.poll ||
    connector.poll === undefined
  ) {
    throw new Error('POLL_CAPABILITY_NOT_AVAILABLE');
  }
  assertCheckpointFence(request);
  if (!sameAccountRef(account, request.account)) {
    throw new Error('POLL_ACCOUNT_BINDING_MISMATCH');
  }
  const page = syncPageSchema.parse(await connector.poll(account, request));
  for (const envelope of page.envelopes) {
    if (
      !sameAccountRef(envelope.account, account) ||
      envelope.connectorSnapshot.accountId !== account.accountId ||
      envelope.connectorSnapshot.connectorId !==
        connector.descriptor().connectorId ||
      envelope.connectorSnapshot.descriptorVersion !==
        connector.descriptor().descriptorVersion
    ) {
      throw new Error('PROVIDER_FACT_BINDING_MISMATCH');
    }
  }
  return page;
}

export async function fetchCommunicationMessage(
  connector: CommunicationConnector,
  account: ConnectorAccount,
  ref: ProviderMessageRef,
): Promise<CanonicalEnvelope> {
  if (
    !connector.descriptor().capabilities.read ||
    connector.fetchMessage === undefined
  ) {
    throw new Error('READ_CAPABILITY_NOT_AVAILABLE');
  }
  const envelope = canonicalEnvelopeSchema.parse(
    await connector.fetchMessage(account, ref),
  );
  assertEnvelopeBinding(
    envelope,
    {
      tenantId: account.tenantId,
      accountId: account.accountId,
      expectedStateVersion: account.stateVersion,
    },
    account.snapshot,
  );
  if (
    envelope.providerMessageRef.providerMessageId !== ref.providerMessageId ||
    envelope.providerMessageRef.providerThreadId !== ref.providerThreadId
  ) {
    throw new Error('PROVIDER_MESSAGE_REF_BINDING_MISMATCH');
  }
  return envelope;
}

export async function fetchCommunicationThread(
  connector: CommunicationConnector,
  account: ConnectorAccount,
  ref: ProviderThreadRef,
): Promise<readonly CanonicalEnvelope[]> {
  if (
    !connector.descriptor().capabilities.threads ||
    connector.fetchThread === undefined
  ) {
    throw new Error('THREAD_CAPABILITY_NOT_AVAILABLE');
  }
  const envelopes = await connector.fetchThread(account, ref);
  return envelopes.map((candidate) => {
    const envelope = canonicalEnvelopeSchema.parse(candidate);
    assertEnvelopeBinding(
      envelope,
      {
        tenantId: account.tenantId,
        accountId: account.accountId,
        expectedStateVersion: account.stateVersion,
      },
      account.snapshot,
    );
    if (envelope.providerMessageRef.providerThreadId !== ref.providerThreadId) {
      throw new Error('PROVIDER_THREAD_REF_BINDING_MISMATCH');
    }
    return envelope;
  });
}

export async function verifyAndNormalizeWebhook(
  connector: CommunicationConnector,
  persistence: VerifiedEventPersistence,
  request: RawWebhookRequest,
): Promise<WebhookNormalizationResult> {
  if (
    !connector.descriptor().capabilities.webhook ||
    connector.verifyWebhook === undefined ||
    connector.normalizeInboundEvent === undefined
  ) {
    throw new Error('WEBHOOK_CAPABILITY_NOT_AVAILABLE');
  }
  const verification = webhookVerificationSchema.parse(
    connector.verifyWebhook(request),
  );
  if (!verification.verified) {
    return { status: 'rejected', reasonCode: verification.reasonCode };
  }
  const verifiedEvent = await persistence.persistVerifiedEvent(
    request,
    verification,
  );
  const normalized = normalizedInboundEventSchema.parse(
    connector.normalizeInboundEvent(verifiedEvent),
  );
  const embedded = normalized.verifiedEvent;
  if (
    embedded.tenantId !== verifiedEvent.tenantId ||
    embedded.accountId !== verifiedEvent.accountId ||
    embedded.providerEventId !== verifiedEvent.providerEventId ||
    embedded.rawEventRef !== verifiedEvent.rawEventRef ||
    embedded.rawPayloadDigest !== verifiedEvent.rawPayloadDigest ||
    embedded.verifiedAt !== verifiedEvent.verifiedAt ||
    embedded.verificationMethod !== verifiedEvent.verificationMethod ||
    !sameSnapshot(embedded.connectorSnapshot, verifiedEvent.connectorSnapshot)
  ) {
    throw new Error('NORMALIZED_EVENT_BINDING_MISMATCH');
  }
  return {
    status: 'normalized',
    event: normalized,
  };
}

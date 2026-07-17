import {
  feedbackParseResultSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import type {
  EffectExecutionArtifact,
  FeedbackContext,
  FeedbackParseResult,
  ProviderSendResult,
  ReconcileSendRequest,
} from '@chief/contracts/approval';
import {
  canonicalEnvelopeSchema,
  connectionHealthSchema,
  connectorAccountSchema,
  normalizedInboundEventSchema,
  syncPageSchema,
} from '@chief/contracts/connectors';
import type {
  CanonicalEnvelope,
  ConnectionHealth,
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorDescriptor,
  CredentialConnectionInput,
  NormalizedInboundEvent,
  PollRequest,
  ProviderMessageRef,
  ProviderThreadRef,
  SyncPage,
  VerifiedProviderEvent,
} from '@chief/contracts/connectors';
import type { CredentialCommunicationConnector } from '@chief/connector-core/communication-connector';

import { imapSmtpImplementationDescriptor } from './implementation-metadata.js';
import {
  dispatchSmtpData,
  reconcileSmtpSent,
  type SmtpWirePort,
} from './smtp.js';

export interface ImapSmtpProviderPort extends SmtpWirePort {
  configureCredentialConnection(
    input: CredentialConnectionInput,
  ): Promise<ConnectorAccount>;
  validateConnection(account: ConnectorAccountRef): Promise<ConnectionHealth>;
  poll(account: ConnectorAccountRef, request: PollRequest): Promise<SyncPage>;
  fetchMessage(
    account: ConnectorAccount,
    ref: ProviderMessageRef,
  ): Promise<CanonicalEnvelope>;
  fetchThread(
    account: ConnectorAccount,
    ref: ProviderThreadRef,
  ): Promise<readonly CanonicalEnvelope[]>;
  normalizeInboundEvent(event: VerifiedProviderEvent): NormalizedInboundEvent;
  parseFeedbackEvent(
    event: VerifiedProviderEvent,
    context: FeedbackContext,
  ): FeedbackParseResult;
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
    throw new Error('IMAP_SMTP_ACCOUNT_BINDING_MISMATCH');
  }
}

function assertArtifactAccount(
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
): void {
  assertAccountRef(account, artifact.account);
  if (
    artifact.connectorSnapshot.connectorId !==
      imapSmtpImplementationDescriptor.connectorId ||
    artifact.connectorSnapshot.descriptorVersion !==
      imapSmtpImplementationDescriptor.descriptorVersion ||
    artifact.connectorSnapshot.accountId !== account.accountId
  ) {
    throw new Error('IMAP_SMTP_EFFECT_SNAPSHOT_MISMATCH');
  }
}

export class ImapSmtpConnector implements CredentialCommunicationConnector {
  public readonly connectorKind = 'communication' as const;

  public constructor(private readonly provider: ImapSmtpProviderPort) {}

  public descriptor(): ConnectorDescriptor {
    return {
      ...imapSmtpImplementationDescriptor,
      authorizationScopes: [
        ...imapSmtpImplementationDescriptor.authorizationScopes,
      ],
      capabilities: { ...imapSmtpImplementationDescriptor.capabilities },
      supportedRuntimeModes: [
        ...imapSmtpImplementationDescriptor.supportedRuntimeModes,
      ],
      constraints: [...imapSmtpImplementationDescriptor.constraints],
    };
  }

  public authorizationStrategy() {
    return {
      strategy: 'credential' as const,
      credentialReferenceClass: 'kms-envelope-mailbox-credential',
    };
  }

  public async configureCredentialConnection(
    input: CredentialConnectionInput,
  ): Promise<ConnectorAccount> {
    if (
      input.connectorId !== imapSmtpImplementationDescriptor.connectorId ||
      input.credentialClass !==
        imapSmtpImplementationDescriptor.credentialReferenceClass
    ) {
      throw new Error('IMAP_SMTP_CREDENTIAL_STRATEGY_MISMATCH');
    }
    const account = connectorAccountSchema.parse(
      await this.provider.configureCredentialConnection(input),
    );
    if (
      account.tenantId !== input.tenantId ||
      account.ownerUserId !== input.userId ||
      account.provider !== imapSmtpImplementationDescriptor.provider ||
      account.channel !== imapSmtpImplementationDescriptor.channel ||
      account.snapshot.connectorId !==
        imapSmtpImplementationDescriptor.connectorId ||
      account.snapshot.descriptorVersion !==
        imapSmtpImplementationDescriptor.descriptorVersion ||
      account.snapshot.selectionState !== 'fallback_candidate' ||
      account.snapshot.runtimeMode !== 'disabled' ||
      account.status !== 'disabled'
    ) {
      throw new Error('IMAP_SMTP_DISABLED_CANDIDATE_ACCOUNT_REQUIRED');
    }
    return account;
  }

  public async validateConnection(
    account: ConnectorAccountRef,
  ): Promise<ConnectionHealth> {
    const health = connectionHealthSchema.parse(
      await this.provider.validateConnection(account),
    );
    assertAccountRef(health.account, account);
    return health;
  }

  public async poll(
    account: ConnectorAccountRef,
    request: PollRequest,
  ): Promise<SyncPage> {
    assertAccountRef(request.account, account);
    return syncPageSchema.parse(await this.provider.poll(account, request));
  }

  public async fetchMessage(
    account: ConnectorAccount,
    ref: ProviderMessageRef,
  ): Promise<CanonicalEnvelope> {
    const envelope = canonicalEnvelopeSchema.parse(
      await this.provider.fetchMessage(account, ref),
    );
    assertAccountRef(envelope.account, {
      tenantId: account.tenantId,
      accountId: account.accountId,
      expectedStateVersion: account.stateVersion,
    });
    return envelope;
  }

  public async fetchThread(
    account: ConnectorAccount,
    ref: ProviderThreadRef,
  ): Promise<readonly CanonicalEnvelope[]> {
    const envelopes = await this.provider.fetchThread(account, ref);
    return envelopes.map((envelope) => canonicalEnvelopeSchema.parse(envelope));
  }

  public async send(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<ProviderSendResult> {
    assertArtifactAccount(account, artifact);
    return dispatchSmtpData({ port: this.provider, account, artifact });
  }

  public async reconcileSend(
    account: ConnectorAccountRef,
    requestValue: ReconcileSendRequest,
  ): Promise<ProviderSendResult> {
    const request = reconcileSendRequestSchema.parse(requestValue);
    assertArtifactAccount(account, request.artifact);
    if (
      request.strategy !== 'smtp-sent-folder' ||
      request.strategyVersion !== '1'
    ) {
      throw new Error('IMAP_SMTP_RECONCILIATION_STRATEGY_UNSUPPORTED');
    }
    return reconcileSmtpSent({
      port: this.provider,
      account,
      artifact: request.artifact,
      maxProviderQueries: request.maxProviderQueries,
    });
  }

  public normalizeInboundEvent(
    event: VerifiedProviderEvent,
  ): NormalizedInboundEvent {
    const normalized = normalizedInboundEventSchema.parse(
      this.provider.normalizeInboundEvent(event),
    );
    if (
      normalized.verifiedEvent.tenantId !== event.tenantId ||
      normalized.verifiedEvent.accountId !== event.accountId ||
      normalized.verifiedEvent.providerEventId !== event.providerEventId
    ) {
      throw new Error('IMAP_SMTP_INBOUND_EVENT_SUBSTITUTION');
    }
    return normalized;
  }

  public parseFeedbackEvent(
    event: VerifiedProviderEvent,
    context: FeedbackContext,
  ): FeedbackParseResult {
    return feedbackParseResultSchema.parse(
      this.provider.parseFeedbackEvent(event, context),
    );
  }
}

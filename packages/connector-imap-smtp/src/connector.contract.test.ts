import {
  effectExecutionArtifactSchema,
  feedbackParseResultSchema,
  feedbackContextSchema,
  reconcileSendRequestSchema,
  type FeedbackContext,
  type FeedbackParseResult,
} from '@chief/contracts/approval';
import {
  connectorAccountSchema,
  connectorDescriptorSchema,
  connectorSnapshotSchema,
  credentialConnectionInputSchema,
  pollRequestSchema,
  verifiedProviderEventSchema,
  type ConnectorAccount,
  type ConnectorAccountRef,
  type CredentialConnectionInput,
} from '@chief/contracts/connectors';
import { tenantIdSchema } from '@chief/contracts/ids';
import {
  createConnectorContractFixtures,
  runCommunicationConnectorContract,
  type ConnectorContractFixtures,
} from '@chief/connector-testkit';
import { describe, expect, it } from 'vitest';

import { ImapSmtpConnector, type ImapSmtpProviderPort } from './connector.js';
import { createDisabledImapSmtpAccount } from './credential.js';
import { imapSmtpImplementationDescriptor } from './implementation-metadata.js';
import { smtpRenderedFixture } from './provider-fixtures.js';
import { sha256, type SmtpCorrelationBinding } from './smtp.js';

function contractFixtures(): ConnectorContractFixtures {
  const base = createConnectorContractFixtures();
  const descriptor = connectorDescriptorSchema.parse({
    ...imapSmtpImplementationDescriptor,
    authorizationScopes: [
      ...imapSmtpImplementationDescriptor.authorizationScopes,
    ],
    capabilities: { ...imapSmtpImplementationDescriptor.capabilities },
    supportedRuntimeModes: [
      ...imapSmtpImplementationDescriptor.supportedRuntimeModes,
    ],
    constraints: [...imapSmtpImplementationDescriptor.constraints],
  });
  const controlDescriptor = connectorDescriptorSchema.parse({
    ...base.descriptor,
    connectorId: descriptor.connectorId,
    descriptorVersion: descriptor.descriptorVersion,
    provider: descriptor.provider,
  });
  const snapshot = connectorSnapshotSchema.parse({
    ...base.snapshot,
    connectorId: descriptor.connectorId,
    descriptorVersion: descriptor.descriptorVersion,
    runtimeMode: 'live',
    selectionState: 'selected',
  });
  const account = connectorAccountSchema.parse({
    ...base.account,
    provider: descriptor.provider,
    channel: descriptor.channel,
    snapshot,
  });
  const messageId = '<operation-a@example.invalid>';
  const raw = smtpRenderedFixture(messageId);
  const artifact = effectExecutionArtifactSchema.parse({
    ...base.artifact,
    renderedPayloadFingerprint: sha256(raw),
    connectorSnapshot: snapshot,
    clientCorrelation: { kind: 'rfc_message_id', value: messageId },
    reconciliationStrategy: 'smtp-sent-folder',
    reconciliationStrategyVersion: '1',
  });
  const reconcileRequest = reconcileSendRequestSchema.parse({
    ...base.reconcileRequest,
    artifact,
    strategy: artifact.reconciliationStrategy,
    strategyVersion: artifact.reconciliationStrategyVersion,
  });
  const verifiedEvent = verifiedProviderEventSchema.parse({
    ...base.verifiedEvent,
    connectorSnapshot: snapshot,
  });
  const pollRequest = pollRequestSchema.parse({
    ...base.pollRequest,
    adapterVersion: descriptor.descriptorVersion,
    checkpoint: {
      ...base.pollRequest.checkpoint,
      kind: 'uid',
      adapterVersion: descriptor.descriptorVersion,
      sourceWatermark: 'INBOX:55:9',
    },
  });
  const feedbackContext = feedbackContextSchema.parse({
    ...base.feedbackContext,
    connectorSnapshot: snapshot,
  });
  return {
    ...base,
    descriptor: controlDescriptor,
    snapshot,
    account,
    artifact,
    reconcileRequest,
    verifiedEvent,
    pollRequest,
    feedbackContext,
  };
}

class ProviderFixture implements ImapSmtpProviderPort {
  public readonly calls: string[] = [];

  public constructor(private readonly fixtures: ConnectorContractFixtures) {}

  public configureCredentialConnection(
    input: CredentialConnectionInput,
  ): Promise<ConnectorAccount> {
    return Promise.resolve(
      createDisabledImapSmtpAccount({
        input,
        accountId: 'disabled-imap-account',
        capabilitySnapshotHash: this.fixtures.snapshot.capabilitySnapshotHash,
        providerAccountDigest:
          'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        observedAt: '2026-07-17T12:00:00.000Z',
      }),
    );
  }

  public validateConnection(account: ConnectorAccountRef) {
    return Promise.resolve({
      account,
      health: 'healthy' as const,
      observedAt: '2026-07-17T12:00:00.000Z',
      capabilitySnapshotHash: this.fixtures.snapshot.capabilitySnapshotHash,
    });
  }

  public poll(account: ConnectorAccountRef) {
    return Promise.resolve({
      envelopes: [
        this.envelope(account, 'provider-message-a', 'provider-thread-a'),
      ],
      nextEncryptedCursor: 'encrypted:INBOX:55:2',
      sourceWatermark: 'INBOX:55:1',
      complete: true,
      providerResponseHash: 'a'.repeat(64),
    });
  }

  public fetchMessage(
    account: ConnectorAccount,
    ref: {
      readonly providerMessageId: string;
      readonly providerThreadId?: string;
    },
  ) {
    return Promise.resolve(
      this.envelope(
        {
          tenantId: account.tenantId,
          accountId: account.accountId,
          expectedStateVersion: account.stateVersion,
        },
        ref.providerMessageId,
        ref.providerThreadId,
      ),
    );
  }

  public fetchThread(
    account: ConnectorAccount,
    ref: { readonly providerThreadId: string },
  ) {
    return Promise.resolve([
      this.envelope(
        {
          tenantId: account.tenantId,
          accountId: account.accountId,
          expectedStateVersion: account.stateVersion,
        },
        'provider-message-a',
        ref.providerThreadId,
      ),
    ]);
  }

  public normalizeInboundEvent(event: typeof this.fixtures.verifiedEvent) {
    return {
      schemaVersion: '1' as const,
      verifiedEvent: event,
      providerMessageId: 'provider-message-a',
      sourceTimestamp: '2026-07-17T12:00:00.000Z',
      canonicalPayloadHash: 'a'.repeat(64),
    };
  }

  public parseFeedbackEvent(
    event: typeof this.fixtures.verifiedEvent,
    context: FeedbackContext,
  ): FeedbackParseResult {
    return feedbackParseResultSchema.parse({
      kind: 'verified' as const,
      fact: {
        schemaVersion: '1' as const,
        tenantId: event.tenantId,
        feedbackFactId: 'imap-dsn-feedback-a',
        providerEventId: event.providerEventId,
        providerMessageId: 'dsn-provider-message-a',
        providerCorrelation: '<operation-a@example.invalid>',
        ...(context.knownOperationId === undefined
          ? {}
          : { operationId: context.knownOperationId }),
        ...(context.knownAttemptId === undefined
          ? {}
          : { attemptId: context.knownAttemptId }),
        feedbackKind: 'bounced' as const,
        providerTimestamp: '2026-07-17T12:00:00.000Z',
        rawEventRef: event.rawEventRef,
        rawPayloadDigest: event.rawPayloadDigest,
        connectorSnapshot: event.connectorSnapshot,
        idempotencyDigest:
          'h1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const,
      },
    });
  }

  public loadRenderedMessage(
    _account: ConnectorAccountRef,
    artifact: typeof this.fixtures.artifact,
  ) {
    return Promise.resolve({
      envelopeFrom: 'chief@example.test',
      envelopeTo: ['recipient@example.test'],
      raw: smtpRenderedFixture(artifact.clientCorrelation.value),
    });
  }

  public persistPreDataBinding() {
    this.calls.push('persist_binding');
    return Promise.resolve();
  }

  public submitData() {
    this.calls.push('smtp_data');
    return Promise.resolve({
      kind: 'accepted' as const,
      code: 250,
      exactResponse: '250 2.0.0 queued as fixture-queue-a',
      serverQueueId: 'fixture-queue-a',
      observedAt: '2026-07-17T12:00:01.000Z',
    });
  }

  public searchSent(input: {
    readonly account: ConnectorAccountRef;
    readonly binding: SmtpCorrelationBinding;
    readonly maxProviderQueries: number;
  }) {
    return Promise.resolve({
      matches: [
        {
          folder: 'Sent',
          uidValidity: '80',
          uid: 4,
          messageId: input.binding.messageId,
          envelopeFingerprint: input.binding.envelopeFingerprint,
          renderedPayloadHash: input.binding.renderedPayloadHash,
          observedAt: '2026-07-17T12:02:00.000Z',
        },
      ],
      conclusiveAbsence: false,
      providerResponseHash: 'b'.repeat(64),
      observedAt: '2026-07-17T12:02:00.000Z',
    });
  }

  private envelope(
    account: ConnectorAccountRef,
    providerMessageId: string,
    providerThreadId?: string,
  ) {
    return {
      schemaVersion: '1' as const,
      account,
      providerMessageRef: {
        providerMessageId,
        ...(providerThreadId === undefined ? {} : { providerThreadId }),
      },
      sourceTimestamp: '2026-07-17T12:00:00.000Z',
      rawBodyRef: `s3://fixture/${providerMessageId}`,
      canonicalPayloadHash: 'a'.repeat(64),
      attachmentCount: 1,
      connectorSnapshot: this.fixtures.snapshot,
    };
  }
}

describe('generic IMAP/SMTP shared connector contract', () => {
  it('creates only a disabled fallback-candidate account from an opaque reference', async () => {
    const fixtures = contractFixtures();
    const connector = new ImapSmtpConnector(new ProviderFixture(fixtures));
    const account = await connector.configureCredentialConnection(
      credentialConnectionInputSchema.parse({
        schemaVersion: '1',
        tenantId: 'tenant-a',
        userId: 'user-a',
        connectorId: 'imap-smtp',
        secretReference:
          'arn:aws:secretsmanager:us-east-2:000000000000:secret:fixture',
        credentialClass: 'kms-envelope-mailbox-credential',
      }),
    );
    expect(account).toMatchObject({
      status: 'disabled',
      health: 'unknown',
      snapshot: {
        selectionState: 'fallback_candidate',
        runtimeMode: 'disabled',
      },
    });
  });

  it('passes the full provider-shaped connector suite', async () => {
    const fixtures = contractFixtures();
    const provider = new ProviderFixture(fixtures);
    const report = await runCommunicationConnectorContract(
      new ImapSmtpConnector(provider),
      fixtures,
    );
    expect(report.checks.filter(({ passed }) => !passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(provider.calls).toEqual([
      'persist_binding',
      'smtp_data',
      'persist_binding',
      'smtp_data',
    ]);
  });

  it('rejects tenant/account substitution before provider activity', async () => {
    const fixtures = contractFixtures();
    const provider = new ProviderFixture(fixtures);
    const connector = new ImapSmtpConnector(provider);
    await expect(
      connector.send(
        {
          ...fixtures.accountRef,
          tenantId: tenantIdSchema.parse('tenant-substituted'),
        },
        fixtures.artifact,
      ),
    ).rejects.toThrow('IMAP_SMTP_ACCOUNT_BINDING_MISMATCH');
    expect(provider.calls).toEqual([]);
  });
});

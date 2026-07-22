import { createHmac } from 'node:crypto';

import {
  feedbackParseResultSchema,
  verifiedFeedbackFactSchema,
} from '@chief/contracts/approval';
import type {
  FeedbackContext,
  FeedbackParseResult,
} from '@chief/contracts/approval';
import {
  connectionHealthSchema,
  normalizedInboundEventSchema,
  webhookVerificationSchema,
} from '@chief/contracts/connectors';
import type {
  ConnectionHealth,
  ConnectorAccount,
  ConnectorAccountRef,
  ConnectorDescriptor,
  CredentialConnectionInput,
  NormalizedInboundEvent,
  ProviderSubscriptionResult,
  RawWebhookRequest,
  SubscriptionMutationRequest,
  VerifiedProviderEvent,
  WebhookVerification,
} from '@chief/contracts/connectors';
import type { CredentialCommunicationConnector } from '@chief/connector-core';

import { twilioDescriptors } from './channels.js';
import type { TwilioChannel } from './channels.js';
import {
  normalizeTwilioProviderEvent,
  twilioProviderEventId,
} from './normalization.js';
import type { TwilioProviderEvent } from './normalization.js';
import {
  parseTwilioRawWebhook,
  verifyTwilioWebhookSignature,
} from './signature.js';
import type { ParsedTwilioWebhook } from './signature.js';

interface RecordedRequest {
  readonly request: RawWebhookRequest;
  readonly parsed: ParsedTwilioWebhook;
}

export interface TwilioFixtureConnectorOptions {
  readonly channel: TwilioChannel;
  readonly tenantId: string;
  readonly accountId: string;
  readonly capabilitySnapshotHash: string;
  readonly runtimeMode: 'live_trial' | 'sandbox' | 'virtual_test' | 'disabled';
  readonly signingKey: string;
  readonly digestKey: string;
  readonly observedAt: string;
  readonly recordedRequests?: readonly RawWebhookRequest[];
  readonly strictRecordedBytes?: boolean;
}

function keyedDigest(key: string, value: string): string {
  const digest = createHmac('sha256', key).update(value).digest('base64url');
  return `h1_v1_${digest}`;
}

export class TwilioSubscriptionMutationDisabledError extends Error {
  public readonly code = 'TWILIO_SUBSCRIPTION_MUTATION_DISABLED';

  public constructor() {
    super('TWILIO_SUBSCRIPTION_MUTATION_DISABLED');
    this.name = 'TwilioSubscriptionMutationDisabledError';
  }
}

function feedbackKind(
  event: TwilioProviderEvent,
):
  | 'accepted'
  | 'delivered'
  | 'delivery_failed'
  | 'reply'
  | 'opt_out'
  | 'reconsent'
  | undefined {
  if (event.kind === 'inbound_message') {
    if (event.optOutType === 'STOP') return 'opt_out';
    if (event.optOutType === 'START') return 'reconsent';
    return 'reply';
  }
  switch (event.rawStatus) {
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'delivery_failed';
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
    case 'sent':
    case 'receiving':
    case 'received':
      return 'accepted';
  }
}

class TwilioFixtureConnector implements CredentialCommunicationConnector {
  public readonly connectorKind = 'communication' as const;
  readonly #descriptor: ConnectorDescriptor;
  readonly #records = new Map<string, RecordedRequest>();

  public constructor(
    protected readonly options: TwilioFixtureConnectorOptions,
  ) {
    this.#descriptor = twilioDescriptors[options.channel];
    if (!this.#descriptor.supportedRuntimeModes.includes(options.runtimeMode)) {
      throw new Error('TWILIO_RUNTIME_MODE_UNSUPPORTED');
    }
    for (const request of options.recordedRequests ?? []) {
      const parsed = parseTwilioRawWebhook(request);
      this.#records.set(this.recordKey(parsed.rawPayloadDigest), {
        request,
        parsed,
      });
    }
  }

  private recordKey(rawPayloadDigest: string): string {
    return `${this.options.tenantId}:${this.options.accountId}:${rawPayloadDigest}`;
  }

  private assertAccount(account: ConnectorAccountRef): void {
    if (
      account.tenantId !== this.options.tenantId ||
      account.accountId !== this.options.accountId
    ) {
      throw new Error('TWILIO_ACCOUNT_BINDING_MISMATCH');
    }
  }

  private recorded(event: VerifiedProviderEvent): RecordedRequest {
    if (
      event.tenantId !== this.options.tenantId ||
      event.accountId !== this.options.accountId
    ) {
      throw new Error('TWILIO_ACCOUNT_BINDING_MISMATCH');
    }
    const record = this.#records.get(this.recordKey(event.rawPayloadDigest));
    if (record === undefined) {
      throw new Error('TWILIO_RAW_EVENT_NOT_AVAILABLE');
    }
    return record;
  }

  public descriptor(): ConnectorDescriptor {
    return this.#descriptor;
  }

  public authorizationStrategy() {
    return {
      strategy: 'credential' as const,
      credentialReferenceClass: 'secrets-manager-twilio-account-credential',
    };
  }

  public configureCredentialConnection(
    _input: CredentialConnectionInput,
  ): Promise<ConnectorAccount> {
    return Promise.reject(new Error('TWILIO_EXTERNAL_CONFIGURATION_DISABLED'));
  }

  public validateConnection(
    account: ConnectorAccountRef,
  ): Promise<ConnectionHealth> {
    this.assertAccount(account);
    const strictlyRecordedVirtualFixture =
      this.options.runtimeMode === 'virtual_test' &&
      (this.options.strictRecordedBytes ?? true) &&
      this.#records.size > 0;
    const state = strictlyRecordedVirtualFixture
      ? { health: 'healthy' as const }
      : this.options.runtimeMode === 'live_trial'
        ? {
            health: 'degraded' as const,
            errorCode: 'TWILIO_LIVE_TRIAL_UNVERIFIED',
          }
        : this.options.runtimeMode === 'sandbox'
          ? {
              health: 'degraded' as const,
              errorCode: 'TWILIO_WHATSAPP_SANDBOX_UNVERIFIED',
            }
          : this.options.runtimeMode === 'virtual_test'
            ? {
                health: 'degraded' as const,
                errorCode: 'TWILIO_VIRTUAL_FIXTURE_NOT_STRICTLY_RECORDED',
              }
            : {
                health: 'failed' as const,
                errorCode: 'TWILIO_RUNTIME_DISABLED',
              };
    return Promise.resolve(
      connectionHealthSchema.parse({
        account,
        ...state,
        observedAt: this.options.observedAt,
        capabilitySnapshotHash: this.options.capabilitySnapshotHash,
      }),
    );
  }

  public subscribe(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult> {
    this.assertAccount(account);
    this.assertAccount(request.account);
    return Promise.reject(new TwilioSubscriptionMutationDisabledError());
  }

  public renewSubscription(
    account: ConnectorAccountRef,
    request: SubscriptionMutationRequest,
  ): Promise<ProviderSubscriptionResult> {
    this.assertAccount(account);
    this.assertAccount(request.account);
    return Promise.reject(new TwilioSubscriptionMutationDisabledError());
  }

  public verifyWebhook(request: RawWebhookRequest): WebhookVerification {
    const verification = verifyTwilioWebhookSignature({
      request,
      signingKey: this.options.signingKey,
    });
    if (!verification.verified) {
      return webhookVerificationSchema.parse(verification);
    }
    let providerEventId: string;
    try {
      const normalized = normalizeTwilioProviderEvent({
        parsed: verification.parsed,
        verifiedEvent: { verifiedAt: request.receivedAt },
        expectedChannel: this.options.channel,
      });
      providerEventId = twilioProviderEventId(verification.parsed);
      if (normalized.channel !== this.options.channel) {
        throw new Error('TWILIO_CHANNEL_MISMATCH');
      }
    } catch (error) {
      return webhookVerificationSchema.parse({
        verified: false,
        reasonCode:
          error instanceof Error ? error.message : 'TWILIO_PAYLOAD_INVALID',
      });
    }
    if (
      (this.options.strictRecordedBytes ?? true) &&
      !this.#records.has(this.recordKey(verification.parsed.rawPayloadDigest))
    ) {
      return webhookVerificationSchema.parse({
        verified: false,
        reasonCode: 'TWILIO_FIXTURE_BYTES_NOT_RECORDED',
      });
    }
    this.#records.set(this.recordKey(verification.parsed.rawPayloadDigest), {
      request,
      parsed: verification.parsed,
    });
    return webhookVerificationSchema.parse({
      verified: true,
      verificationMethod: 'twilio-request-signature-v1',
      providerEventId,
      rawPayloadDigest: verification.parsed.rawPayloadDigest,
    });
  }

  public normalizeInboundEvent(
    event: VerifiedProviderEvent,
  ): NormalizedInboundEvent {
    const normalized = normalizeTwilioProviderEvent({
      parsed: this.recorded(event).parsed,
      verifiedEvent: event,
      expectedChannel: this.options.channel,
    });
    return normalizedInboundEventSchema.parse({
      schemaVersion: '1',
      verifiedEvent: event,
      providerMessageId: normalized.messageSid,
      ...(normalized.kind === 'inbound_message'
        ? { providerThreadId: normalized.providerThreadId }
        : {}),
      sourceTimestamp: normalized.sourceTimestamp,
      canonicalPayloadHash: normalized.rawPayloadDigest,
    });
  }

  public parseFeedbackEvent(
    event: VerifiedProviderEvent,
    context: FeedbackContext,
  ): FeedbackParseResult {
    let normalized: TwilioProviderEvent;
    try {
      normalized = normalizeTwilioProviderEvent({
        parsed: this.recorded(event).parsed,
        verifiedEvent: event,
        expectedChannel: this.options.channel,
      });
    } catch (error) {
      return feedbackParseResultSchema.parse({
        kind: 'invalid',
        reason:
          error instanceof Error ? error.message : 'TWILIO_FEEDBACK_INVALID',
      });
    }
    const kind = feedbackKind(normalized);
    if (kind === undefined) {
      return feedbackParseResultSchema.parse({
        kind: 'unsupported',
        reason: 'TWILIO_FEEDBACK_KIND_UNSUPPORTED',
      });
    }
    const providerEventId = event.providerEventId;
    const providerMessageId = normalized.messageSid;
    return feedbackParseResultSchema.parse({
      kind: 'verified',
      fact: verifiedFeedbackFactSchema.parse({
        schemaVersion: '1',
        tenantId: context.tenantId,
        feedbackFactId: `twilio-feedback:${providerEventId}`,
        providerEventId,
        providerMessageId,
        providerCorrelation: providerMessageId,
        ...(context.knownOperationId === undefined
          ? {}
          : { operationId: context.knownOperationId }),
        ...(context.knownAttemptId === undefined
          ? {}
          : { attemptId: context.knownAttemptId }),
        feedbackKind: kind,
        providerTimestamp: normalized.sourceTimestamp,
        rawEventRef: event.rawEventRef,
        rawPayloadDigest: event.rawPayloadDigest,
        connectorSnapshot: context.connectorSnapshot,
        idempotencyDigest: keyedDigest(
          this.options.digestKey,
          [
            context.tenantId,
            context.account.accountId,
            providerEventId,
            providerMessageId,
            kind,
            normalized.sourceTimestamp,
            event.rawPayloadDigest,
          ].join('\u0000'),
        ),
      }),
    });
  }
}

export function createTwilioFixtureConnector(
  options: TwilioFixtureConnectorOptions,
): CredentialCommunicationConnector {
  return new TwilioFixtureConnector(options);
}

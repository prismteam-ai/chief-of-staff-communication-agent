import {
  contactChannelPolicySchema,
  effectExecutionArtifactSchema,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
  verifiedProviderEventSchema,
} from '@chief/contracts/connectors';
import type { VerifiedProviderEvent } from '@chief/contracts/connectors';
import { userIdSchema } from '@chief/contracts/ids';
import type { CredentialCommunicationConnector } from '@chief/connector-core';
import { reduceContactPolicy } from '@chief/domain/contact-policy';
import {
  assertCommunicationConnectorContract,
  createConnectorContractFixtures,
  FIXTURE_KEYED_DIGEST,
  FIXTURE_NOW,
} from '@chief/connector-testkit';
import type { ConnectorContractFixtures } from '@chief/connector-testkit';
import { describe, expect, it } from 'vitest';

import { twilioDescriptors, twilioUnsupportedFacts } from './channels.js';
import { createTwilioFixtureConnector } from './connector.js';
import {
  createTwilioSignedFixtureRequest,
  twilioProviderBodies,
} from './fixtures.js';
import {
  normalizeTwilioProviderEvent,
  twilioProviderEventId,
} from './normalization.js';
import type {
  TwilioInboundMessage,
  TwilioProviderEvent,
  TwilioStatusCallback,
} from './normalization.js';
import {
  evaluateTwilioSendEligibility,
  prepareTwilioEffectArtifact,
  twilioSmsOptOutFact,
  twilioWhatsAppOptInFact,
  twilioWhatsAppWindowClosedFact,
  twilioWhatsAppWindowFact,
} from './policy.js';
import {
  parseTwilioRawWebhook,
  verifyTwilioWebhookSignature,
} from './signature.js';
import { reduceTwilioStatus } from './status.js';

const FIXTURE_SIGNING_KEY =
  'synthetic-fixture-signing-material-not-valid-for-any-twilio-account';
const FIXTURE_DIGEST_KEY =
  'synthetic-fixture-digest-material-not-valid-outside-tests';
function signed(
  channel: 'sms' | 'whatsapp',
  rawBody: string,
  providerVisibleUrl?: string,
) {
  return createTwilioSignedFixtureRequest({
    channel,
    rawBody,
    signingKey: FIXTURE_SIGNING_KEY,
    ...(providerVisibleUrl === undefined ? {} : { providerVisibleUrl }),
  });
}

function normalized(
  channel: 'sms' | 'whatsapp',
  rawBody: string,
): TwilioProviderEvent {
  const request = signed(channel, rawBody);
  return normalizeTwilioProviderEvent({
    parsed: parseTwilioRawWebhook(request),
    verifiedEvent: { verifiedAt: request.receivedAt },
    expectedChannel: channel,
  });
}

function inbound(
  channel: 'sms' | 'whatsapp',
  rawBody: string,
): TwilioInboundMessage {
  const event = normalized(channel, rawBody);
  if (event.kind !== 'inbound_message') {
    throw new Error('expected inbound fixture');
  }
  return event;
}

function status(rawBody: string): TwilioStatusCallback {
  const event = normalized('sms', rawBody);
  if (event.kind !== 'status_callback') {
    throw new Error('expected status fixture');
  }
  return event;
}

function contractFixtures(
  channel: 'sms' | 'whatsapp',
): ConnectorContractFixtures {
  // The frozen runner uses this testkit-owned descriptor/snapshot only for its
  // endpoint-free generic effect controls. The connector under test returns
  // the independent, truthful Twilio descriptor below.
  const runnerControlFixtures = createConnectorContractFixtures();
  const descriptor = twilioDescriptors[channel];
  const webhookRequest = signed(
    channel,
    channel === 'sms'
      ? twilioProviderBodies.smsStatusDelivered
      : twilioProviderBodies.whatsappStatusRead,
  );
  const parsed = parseTwilioRawWebhook(webhookRequest);
  const verifiedEvent = verifiedProviderEventSchema.parse({
    ...runnerControlFixtures.verifiedEvent,
    providerEventId: twilioProviderEventId(parsed),
    rawEventRef: `s3://private-fixture/${descriptor.connectorId}/status`,
    rawPayloadDigest: parsed.rawPayloadDigest,
    verificationMethod: 'twilio-request-signature-v1',
  });
  return {
    ...runnerControlFixtures,
    verifiedEvent,
    webhookRequest,
  };
}

function fixtureConnector(
  channel: 'sms' | 'whatsapp',
  fixtures: ConnectorContractFixtures,
): CredentialCommunicationConnector {
  return createTwilioFixtureConnector({
    channel,
    tenantId: fixtures.accountRef.tenantId,
    accountId: fixtures.accountRef.accountId,
    capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
    runtimeMode: 'virtual_test',
    signingKey: FIXTURE_SIGNING_KEY,
    digestKey: FIXTURE_DIGEST_KEY,
    observedAt: FIXTURE_NOW,
    recordedRequests: [fixtures.webhookRequest],
  });
}

describe('Twilio shared webhook verification', () => {
  it('binds the exact provider-visible URL and signed provider fields', () => {
    const request = signed('sms', twilioProviderBodies.smsInboundMedia);
    expect(
      verifyTwilioWebhookSignature({
        request,
        signingKey: FIXTURE_SIGNING_KEY,
      }).verified,
    ).toBe(true);

    const url = new URL(request.providerVisibleUrl);
    const changedUrls = [
      request.providerVisibleUrl.replace('https:', 'http:'),
      request.providerVisibleUrl.replace('callbacks.', 'other.'),
      `${url.protocol}//${url.hostname}:8443${url.pathname}${url.search}`,
      request.providerVisibleUrl.replace('/twilio/sms', '/twilio/status'),
      request.providerVisibleUrl.replace('stage=wave1b', 'stage=other'),
      request.providerVisibleUrl.replace(
        'stage=wave1b&tenant=fixture',
        'tenant=fixture&stage=wave1b',
      ),
    ];
    for (const providerVisibleUrl of changedUrls) {
      expect(
        verifyTwilioWebhookSignature({
          request: { ...request, providerVisibleUrl },
          signingKey: FIXTURE_SIGNING_KEY,
        }),
      ).toMatchObject({
        verified: false,
        reasonCode: 'TWILIO_SIGNATURE_INVALID',
      });
    }

    const changedRawBody = twilioProviderBodies.smsInboundMedia.replace(
      'NumMedia=2',
      'NumMedia=1',
    );
    expect(
      verifyTwilioWebhookSignature({
        request: {
          ...request,
          rawBodyBase64: Buffer.from(changedRawBody).toString('base64'),
        },
        signingKey: FIXTURE_SIGNING_KEY,
      }),
    ).toMatchObject({
      verified: false,
      reasonCode: 'TWILIO_SIGNATURE_INVALID',
    });
  });

  it('keeps virtual fixtures byte exact even for equivalent reserialization', () => {
    const fixtures = contractFixtures('sms');
    const connector = fixtureConnector('sms', fixtures);
    const pairs = [
      ...new URLSearchParams(twilioProviderBodies.smsStatusDelivered),
    ];
    pairs.sort(([left], [right]) => left.localeCompare(right));
    const reserialized = new URLSearchParams(pairs).toString();
    expect(reserialized).not.toBe(twilioProviderBodies.smsStatusDelivered);
    const request = signed('sms', reserialized);
    expect(
      verifyTwilioWebhookSignature({
        request,
        signingKey: FIXTURE_SIGNING_KEY,
      }).verified,
    ).toBe(true);
    expect(connector.verifyWebhook?.(request)).toEqual({
      verified: false,
      reasonCode: 'TWILIO_FIXTURE_BYTES_NOT_RECORDED',
    });
  });
});

describe('Twilio inbound normalization', () => {
  it('preserves provider-shaped SMS/MMS media without fetching it', () => {
    const message = inbound('sms', twilioProviderBodies.smsInboundMedia);
    expect(message).toMatchObject({
      messageSid: 'MM11111111111111111111111111111111',
      from: '+15550000001',
      to: '+15550000002',
      sourceTimestampFact: 'provider',
    });
    expect(message.media).toEqual([
      {
        index: 0,
        providerAttachmentId: 'MM11111111111111111111111111111111:media:0',
        mediaUrl: 'https://api.example.invalid/media/ME000',
        contentType: 'image/png',
        fetchPolicy: 'never_in_connector',
      },
      {
        index: 1,
        providerAttachmentId: 'MM11111111111111111111111111111111:media:1',
        mediaUrl: 'https://api.example.invalid/media/ME001',
        contentType: 'application/pdf',
        fetchPolicy: 'never_in_connector',
      },
    ]);
    expect(message.providerThreadId).toMatch(/^twilio-thread:[a-f0-9]{64}$/u);
  });

  it('rejects cross-channel and account substitutions', () => {
    const fixtures = contractFixtures('sms');
    const connector = fixtureConnector('sms', fixtures);
    const whatsapp = signed('whatsapp', twilioProviderBodies.whatsappInbound);
    expect(connector.verifyWebhook?.(whatsapp)).toMatchObject({
      verified: false,
      reasonCode: 'TWILIO_CHANNEL_MISMATCH',
    });
    expect(() =>
      connector.validateConnection(
        connectorAccountRefSchema.parse({
          ...fixtures.accountRef,
          accountId: 'account-other',
        }),
      ),
    ).toThrow('TWILIO_ACCOUNT_BINDING_MISMATCH');
    const substituted: VerifiedProviderEvent =
      verifiedProviderEventSchema.parse({
        ...fixtures.verifiedEvent,
        accountId: 'account-other',
        connectorSnapshot: {
          ...fixtures.verifiedEvent.connectorSnapshot,
          accountId: 'account-other',
        },
      });
    expect(
      connector.parseFeedbackEvent?.(substituted, fixtures.feedbackContext),
    ).toEqual({ kind: 'invalid', reason: 'TWILIO_ACCOUNT_BINDING_MISMATCH' });
  });
});

describe('Twilio canonical callback reducer', () => {
  it('converges duplicates and partial out-of-order callbacks without regression', () => {
    const callbacks = [
      status(twilioProviderBodies.smsStatusQueued),
      status(twilioProviderBodies.smsStatusSent),
      status(twilioProviderBodies.smsStatusSent),
      status(twilioProviderBodies.smsStatusDelivered),
      status(twilioProviderBodies.smsStatusQueued),
      status(twilioProviderBodies.smsStatusUndelivered),
    ];
    let current: ReturnType<typeof reduceTwilioStatus>['state'] | undefined;
    const reductions = callbacks.map((callback) => {
      const reduction = reduceTwilioStatus(current, callback.rawStatus);
      current = reduction.state;
      return reduction;
    });
    expect(reductions.map(({ state }) => state)).toEqual([
      'queued',
      'provider_accepted',
      'provider_accepted',
      'delivered',
      'delivered',
      'delivered',
    ]);
    expect(reductions.map(({ reason }) => reason)).toEqual([
      'advanced',
      'advanced',
      'duplicate',
      'advanced',
      'out_of_order_ignored',
      'out_of_order_ignored',
    ]);
    expect(reductions.map(({ state }) => state)).not.toContain('sent');
    expect(reductions.map(({ state }) => state)).not.toContain('accepted');
    expect(reductions.map(({ state }) => state)).not.toContain('failed');
  });

  it('allows higher-confidence delivery after a partial failure callback', () => {
    const failed = reduceTwilioStatus(undefined, 'undelivered');
    expect(reduceTwilioStatus(failed.state, 'sent')).toMatchObject({
      state: 'delivery_failed',
      changed: false,
      reason: 'out_of_order_ignored',
    });
    expect(reduceTwilioStatus(failed.state, 'delivered')).toMatchObject({
      state: 'delivered',
      changed: true,
      reason: 'advanced',
    });
  });
});

describe('Twilio contact policy and effect-artifact preflight', () => {
  const scope = {
    tenantId: 'tenant-a',
    contactIdentityDigest: FIXTURE_KEYED_DIGEST,
    connectorAccountId: 'account-a',
    brandId: 'brand-a',
  };

  it('uses account-current OptOutType STOP/START and denies suppression', () => {
    const stopMessage = inbound('sms', twilioProviderBodies.smsStop);
    const stop = twilioSmsOptOutFact({ message: stopMessage, scope });
    expect(stop.kind).toBe('fact');
    if (stop.kind !== 'fact') throw new Error('expected STOP fact');
    const suppressed = reduceContactPolicy({
      actorTenantId: stop.fact.tenantId,
      facts: [stop.fact],
      observedAt: '2026-07-17T12:01:30.000Z',
      reducerVersion: 'twilio-contact-v1',
    });
    expect(suppressed.state).toBe('suppressed');
    expect(
      evaluateTwilioSendEligibility({ channel: 'sms', policy: suppressed }),
    ).toEqual({
      eligible: false,
      reason: 'contact_policy_not_allowed',
    });

    const startMessage = inbound('sms', twilioProviderBodies.smsStart);
    const start = twilioSmsOptOutFact({
      message: startMessage,
      scope,
      currentProviderOptOutFactId: stop.fact.factId,
    });
    expect(start.kind).toBe('fact');
    if (start.kind !== 'fact') throw new Error('expected START fact');
    const allowed = reduceContactPolicy({
      actorTenantId: stop.fact.tenantId,
      facts: [stop.fact, start.fact],
      observedAt: '2026-07-17T12:02:30.000Z',
      reducerVersion: 'twilio-contact-v1',
      previous: suppressed,
    });
    expect(allowed.state).toBe('allowed');
    expect(
      evaluateTwilioSendEligibility({ channel: 'sms', policy: allowed }),
    ).toEqual({ eligible: true, route: 'sms' });
  });

  it('keeps body-only STOP evidence typed unknown', () => {
    const message = inbound('sms', twilioProviderBodies.smsBodyOnlyStop);
    expect(twilioSmsOptOutFact({ message, scope })).toEqual({
      kind: 'unknown',
      reason:
        'body text alone does not prove account-current provider STOP/START handling',
    });
    expect(twilioUnsupportedFacts.smsHistoricalBackfill.state).toBe('unknown');
  });

  it('requires WhatsApp opt-in plus window, or separately approved template', () => {
    const message = inbound('whatsapp', twilioProviderBodies.whatsappInbound);
    const optIn = twilioWhatsAppOptInFact({
      message,
      scope,
      evidence: 'explicit_user_opt_in',
    });
    const open = twilioWhatsAppWindowFact({ message, scope });
    const withinWindow = reduceContactPolicy({
      actorTenantId: optIn.tenantId,
      facts: [optIn, open],
      observedAt: '2026-07-17T12:09:00.000Z',
      reducerVersion: 'twilio-contact-v1',
    });
    expect(withinWindow.state).toBe('allowed');
    expect(
      evaluateTwilioSendEligibility({
        channel: 'whatsapp',
        policy: withinWindow,
        verifiedOptInFactId: optIn.factId,
      }),
    ).toEqual({ eligible: true, route: 'free_form' });

    const closed = twilioWhatsAppWindowClosedFact({
      message,
      scope,
      openWindowFactId: open.factId,
    });
    const outsideWindow = reduceContactPolicy({
      actorTenantId: optIn.tenantId,
      facts: [optIn, open, closed],
      observedAt: '2026-07-18T12:09:00.000Z',
      reducerVersion: 'twilio-contact-v1',
      previous: withinWindow,
    });
    expect(outsideWindow.state).toBe('window_closed');
    expect(
      evaluateTwilioSendEligibility({
        channel: 'whatsapp',
        policy: outsideWindow,
        verifiedOptInFactId: optIn.factId,
      }),
    ).toEqual({
      eligible: false,
      reason: 'customer_service_window_closed',
    });
    expect(
      evaluateTwilioSendEligibility({
        channel: 'whatsapp',
        policy: outsideWindow,
        verifiedOptInFactId: optIn.factId,
        template: {
          templateId: 'HX00000000000000000000000000000000',
          approvalEvidenceRef: 'fixture:twilio-sandbox-template-catalog-v1',
          approvalState: 'approved',
        },
      }),
    ).toEqual({ eligible: true, route: 'template' });
  });

  it('returns only a non-effect receipt after an eligible artifact preflight', () => {
    const fixtures = contractFixtures('sms');
    const snapshot = connectorSnapshotSchema.parse({
      ...fixtures.snapshot,
      connectorId: twilioDescriptors.sms.connectorId,
      descriptorVersion: twilioDescriptors.sms.descriptorVersion,
      runtimeMode: 'virtual_test',
    });
    const artifact = effectExecutionArtifactSchema.parse({
      ...fixtures.artifact,
      connectorSnapshot: snapshot,
    });
    const allowedPolicy = contactChannelPolicySchema.parse({
      schemaVersion: '1',
      tenantId: fixtures.accountRef.tenantId,
      contactIdentityDigest: FIXTURE_KEYED_DIGEST,
      channel: 'sms',
      connectorAccountId: fixtures.accountRef.accountId,
      brandId: 'brand-a',
      state: 'allowed',
      winningFactId: 'allow-a',
      applicableFactIds: ['allow-a'],
      reducerVersion: 'twilio-contact-v1',
      projectionVersion: 1,
      updatedAt: FIXTURE_NOW,
    });
    const eligibility = evaluateTwilioSendEligibility({
      channel: 'sms',
      policy: allowedPolicy,
    });
    expect(
      prepareTwilioEffectArtifact({
        descriptor: twilioDescriptors.sms,
        artifact,
        eligibility,
      }),
    ).toMatchObject({
      route: 'sms',
      externalEffect: false,
      providerRequestCreated: false,
    });
  });
});

describe('Twilio frozen communication-connector contract', () => {
  it.each(['sms', 'whatsapp'] as const)(
    'passes the real contract runner for %s',
    async (channel) => {
      const fixtures = contractFixtures(channel);
      const connector = fixtureConnector(channel, fixtures);
      const report = await assertCommunicationConnectorContract(
        connector,
        fixtures,
      );
      expect(report.passed).toBe(true);
      expect(report.checks.every(({ passed }) => passed)).toBe(true);
      expect(
        report.checks.find(
          ({ name }) =>
            name === 'effect artifact and capability snapshot are current',
        ),
      ).toMatchObject({ passed: true });
      expect(connector.descriptor()).toBe(twilioDescriptors[channel]);
      expect(connector.descriptor().capabilities.externalEffect).toBe(false);
      expect(connector.descriptor().capabilities.send).toBe(false);
      expect(connector.send).toBeUndefined();
      expect(connector.reconcileSend).toBeUndefined();
      expect(fixtures.descriptor.connectorId).not.toBe(
        connector.descriptor().connectorId,
      );
      expect(fixtures.descriptor.constraints).toContain('contract-test-only');
      expect(fixtures.descriptor.capabilities.externalEffect).toBe(true);
      expect(fixtures.snapshot.runtimeMode).toBe('live');
      await expect(
        connector.validateConnection(fixtures.accountRef),
      ).resolves.toMatchObject({ health: 'healthy' });
    },
  );

  it('fails closed for fixture subscription creation and renewal', async () => {
    const fixtures = contractFixtures('sms');
    const connector = fixtureConnector('sms', fixtures);
    expect(connector.subscribe).toBeDefined();
    expect(connector.renewSubscription).toBeDefined();
    if (
      connector.subscribe === undefined ||
      connector.renewSubscription === undefined
    ) {
      throw new Error('expected webhook subscription method parity');
    }
    await expect(
      connector.subscribe(fixtures.accountRef, fixtures.subscriptionRequest),
    ).rejects.toMatchObject({
      name: 'TwilioSubscriptionMutationDisabledError',
      code: 'TWILIO_SUBSCRIPTION_MUTATION_DISABLED',
      message: 'TWILIO_SUBSCRIPTION_MUTATION_DISABLED',
    });
    await expect(
      connector.renewSubscription(
        fixtures.accountRef,
        fixtures.subscriptionRequest,
      ),
    ).rejects.toMatchObject({
      name: 'TwilioSubscriptionMutationDisabledError',
      code: 'TWILIO_SUBSCRIPTION_MUTATION_DISABLED',
      message: 'TWILIO_SUBSCRIPTION_MUTATION_DISABLED',
    });
  });

  it('degrades unproven trial/sandbox modes and fails disabled mode', async () => {
    const cases = [
      {
        channel: 'sms' as const,
        runtimeMode: 'live_trial' as const,
        errorCode: 'TWILIO_LIVE_TRIAL_UNVERIFIED',
        health: 'degraded',
      },
      {
        channel: 'whatsapp' as const,
        runtimeMode: 'sandbox' as const,
        errorCode: 'TWILIO_WHATSAPP_SANDBOX_UNVERIFIED',
        health: 'degraded',
      },
      {
        channel: 'sms' as const,
        runtimeMode: 'disabled' as const,
        errorCode: 'TWILIO_RUNTIME_DISABLED',
        health: 'failed',
      },
    ];
    for (const testCase of cases) {
      const fixtures = contractFixtures(testCase.channel);
      const connector = createTwilioFixtureConnector({
        channel: testCase.channel,
        tenantId: fixtures.accountRef.tenantId,
        accountId: fixtures.accountRef.accountId,
        capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
        runtimeMode: testCase.runtimeMode,
        signingKey: FIXTURE_SIGNING_KEY,
        digestKey: FIXTURE_DIGEST_KEY,
        observedAt: FIXTURE_NOW,
        recordedRequests: [fixtures.webhookRequest],
      });
      await expect(
        connector.validateConnection(fixtures.accountRef),
      ).resolves.toMatchObject({
        health: testCase.health,
        errorCode: testCase.errorCode,
      });
    }
  });

  it('never configures credentials or reaches a provider target', async () => {
    const fixtures = contractFixtures('sms');
    const connector = createTwilioFixtureConnector({
      channel: 'sms',
      tenantId: fixtures.accountRef.tenantId,
      accountId: fixtures.accountRef.accountId,
      capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
      runtimeMode: 'virtual_test',
      signingKey: FIXTURE_SIGNING_KEY,
      digestKey: FIXTURE_DIGEST_KEY,
      observedAt: FIXTURE_NOW,
      recordedRequests: [fixtures.webhookRequest],
    });
    await expect(
      connector.configureCredentialConnection?.({
        schemaVersion: '1',
        tenantId: fixtures.accountRef.tenantId,
        userId: userIdSchema.parse('user-a'),
        connectorId: twilioDescriptors.sms.connectorId,
        secretReference: 'fixture-only:no-secret-read',
        credentialClass: 'secrets-manager-twilio-account-credential',
      }),
    ).rejects.toThrow('TWILIO_EXTERNAL_CONFIGURATION_DISABLED');
    expect(twilioDescriptors.sms.capabilities).toMatchObject({
      read: false,
      send: false,
      poll: false,
      externalEffect: false,
    });
    expect(twilioDescriptors.whatsapp.capabilities).toMatchObject({
      read: false,
      send: false,
      poll: false,
      externalEffect: false,
    });
  });
});

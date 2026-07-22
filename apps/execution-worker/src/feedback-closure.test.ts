import {
  contactChannelPolicySchema,
  sendAttemptSchema,
  suppressionFactSchema,
  verifiedFeedbackFactSchema,
  type ContactChannelPolicy,
  type SuppressionFact,
  type VerifiedFeedbackFact,
} from '@chief/contracts/approval';
import {
  connectorAccountRefSchema,
  connectorSnapshotSchema,
  verifiedProviderEventSchema,
} from '@chief/contracts/connectors';
import { keyedDigestValueSchema, tenantIdSchema } from '@chief/contracts/ids';
import type {
  FeedbackAdapter,
  FeedbackEventOutboxItem,
  FeedbackPublisher,
  FeedbackReplayItem,
} from '@chief/connector-core';
import { describe, expect, it, vi } from 'vitest';

import {
  processFeedbackClosure,
  type FeedbackClosurePersistence,
  type FeedbackProjectionState,
} from './feedback-closure.js';

const NOW = '2026-07-17T12:10:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DIGEST = keyedDigestValueSchema.parse(`h1_v1_${'A'.repeat(43)}`);
const CORRELATION_DIGEST = keyedDigestValueSchema.parse(
  `h1_v1_${'B'.repeat(42)}A`,
);
const snapshot = connectorSnapshotSchema.parse({
  connectorId: 'twilio-sms',
  descriptorVersion: 'twilio-sms-v1',
  accountId: 'account-twilio-001',
  capabilitySnapshotHash: HASH_A,
  runtimeMode: 'live_trial',
  selectionState: 'selected',
});
const account = connectorAccountRefSchema.parse({
  tenantId: 'tenant-redwood',
  accountId: 'account-twilio-001',
  expectedStateVersion: 5,
});
const event = verifiedProviderEventSchema.parse({
  schemaVersion: '1',
  tenantId: 'tenant-redwood',
  accountId: 'account-twilio-001',
  providerEventId: 'provider-event-001',
  rawEventRef: 's3://raw-events/provider-event-001',
  rawPayloadDigest: HASH_B,
  verifiedAt: NOW,
  verificationMethod: 'twilio-hmac-sha1',
  connectorSnapshot: snapshot,
});
const attempt = sendAttemptSchema.parse({
  schemaVersion: '1',
  tenantId: 'tenant-redwood',
  operationId: 'operation-send-001',
  attemptId: 'attempt-send-001',
  artifactHash: HASH_A,
  stableIdempotencyKey: 'stable-operation-send-001',
  lifecycleState: 'dispatching',
  transportState: 'queued',
  clientCorrelation: {
    kind: 'client_reference',
    value: 'chief-operation-send-001',
  },
  correlationBindingVersion: 'correlation-v1',
  retryDecision: 'not_applicable',
  attemptedAt: NOW,
  stateVersion: 1,
});

function fact(
  kind: VerifiedFeedbackFact['feedbackKind'],
  id = `feedback-${kind}`,
): VerifiedFeedbackFact {
  return verifiedFeedbackFactSchema.parse({
    schemaVersion: '1',
    tenantId: 'tenant-redwood',
    feedbackFactId: id,
    providerEventId: event.providerEventId,
    providerMessageId: 'SM123',
    providerCorrelation: 'SM123',
    operationId: attempt.operationId,
    attemptId: attempt.attemptId,
    feedbackKind: kind,
    providerTimestamp: NOW,
    rawEventRef: event.rawEventRef,
    rawPayloadDigest: event.rawPayloadDigest,
    connectorSnapshot: snapshot,
    idempotencyDigest: DIGEST,
  });
}

class MemoryFeedbackPersistence implements FeedbackClosurePersistence {
  public readonly order: string[] = [];
  public projectedAttempt = attempt;
  public projectedPolicy: ContactChannelPolicy | undefined;
  public answered = false;
  public facts: SuppressionFact[] = [];

  public persistFactAndOutbox(
    _fact: VerifiedFeedbackFact,
    _outbox: FeedbackEventOutboxItem,
  ): Promise<'created'> {
    this.order.push('fact_and_outbox');
    return Promise.resolve('created');
  }

  public persistReplay(_item: FeedbackReplayItem): Promise<void> {
    this.order.push('replay');
    return Promise.resolve();
  }

  public loadProjectionState(): Promise<FeedbackProjectionState> {
    return Promise.resolve({
      attempt: this.projectedAttempt,
      providerCorrelationDigest: CORRELATION_DIGEST,
      policyScope: {
        tenantId: attempt.tenantId,
        contactIdentityDigest: DIGEST,
        channel: 'sms',
        connectorAccountId: account.accountId,
        brandId: 'brand-redwood' as ContactChannelPolicy['brandId'],
      },
      policyFacts: this.facts,
      ...(this.projectedPolicy === undefined
        ? {}
        : { currentPolicy: this.projectedPolicy }),
    });
  }

  public commitProjection(input: {
    readonly fact: VerifiedFeedbackFact;
    readonly attempt?: typeof attempt;
    readonly contactPolicy?: ContactChannelPolicy;
    readonly markAnswered: boolean;
  }): Promise<'created'> {
    this.order.push('projection');
    if (input.attempt !== undefined) this.projectedAttempt = input.attempt;
    if (input.contactPolicy !== undefined)
      this.projectedPolicy = input.contactPolicy;
    this.answered = input.markAnswered;
    return Promise.resolve('created');
  }
}

function adapter(parsedFact: VerifiedFeedbackFact): FeedbackAdapter {
  return {
    parseFeedbackEvent: () => ({ kind: 'verified', fact: parsedFact }),
  };
}

function publisher(order: string[]): FeedbackPublisher {
  return {
    publish: () => {
      order.push('published');
      return Promise.resolve();
    },
  };
}

async function close(
  persistence: MemoryFeedbackPersistence,
  parsedFact: VerifiedFeedbackFact,
) {
  return processFeedbackClosure({
    adapter: adapter(parsedFact),
    persistence,
    publisher: publisher(persistence.order),
    event,
    context: {
      tenantId: attempt.tenantId,
      account,
      connectorSnapshot: snapshot,
      knownOperationId: attempt.operationId,
      knownAttemptId: attempt.attemptId,
    },
    observedAt: NOW,
    reducerVersion: 'contact-policy-v2',
  });
}

describe('provider feedback closure', () => {
  it('persists fact/outbox before publish and closes out-of-order delivery', async () => {
    const persistence = new MemoryFeedbackPersistence();
    await expect(close(persistence, fact('delivered'))).resolves.toMatchObject({
      processing: { status: 'persisted' },
      projection: 'created',
    });
    expect(persistence.order).toEqual([
      'fact_and_outbox',
      'published',
      'projection',
    ]);
    expect(persistence.projectedAttempt.transportState).toBe('delivered');
    expect(persistence.projectedAttempt.providerCorrelationDigest).toBe(
      CORRELATION_DIGEST,
    );
  });

  it.each([
    ['opt_out', 'suppressed'],
    ['complaint', 'suppressed'],
    ['window_closed', 'window_closed'],
  ] as const)(
    'reduces %s into current contact policy %s',
    async (kind, state) => {
      const persistence = new MemoryFeedbackPersistence();
      await close(persistence, fact(kind));
      expect(persistence.projectedPolicy?.state).toBe(state);
    },
  );

  it('closes a bounce into terminal transport state and suppression policy', async () => {
    const persistence = new MemoryFeedbackPersistence();
    await close(persistence, fact('bounced'));
    expect(persistence.projectedAttempt.transportState).toBe('bounced');
    expect(persistence.projectedAttempt.providerCorrelationDigest).toBe(
      CORRELATION_DIGEST,
    );
    expect(persistence.projectedPolicy?.state).toBe('suppressed');
  });

  it('closes an unsubscribe into suppression without inventing transport delivery', async () => {
    const persistence = new MemoryFeedbackPersistence();
    await close(persistence, fact('unsubscribe'));
    expect(persistence.projectedPolicy?.state).toBe('suppressed');
    expect(persistence.projectedAttempt.transportState).toBe('queued');
  });

  it('requires provider-verified re-consent to supersede opt-out', async () => {
    const persistence = new MemoryFeedbackPersistence();
    const optOut = suppressionFactSchema.parse({
      schemaVersion: '1',
      tenantId: 'tenant-redwood',
      factId: 'feedback-opt_out',
      contactIdentityDigest: DIGEST,
      channel: 'sms',
      connectorAccountId: 'account-twilio-001',
      brandId: 'brand-redwood',
      kind: 'provider_opt_out',
      authority: 'provider',
      providerEventId: event.providerEventId,
      rawEventRef: event.rawEventRef,
      effectiveAt: '2026-07-17T12:00:00.000Z',
    });
    persistence.facts = [optOut];
    persistence.projectedPolicy = contactChannelPolicySchema.parse({
      schemaVersion: '1',
      tenantId: optOut.tenantId,
      contactIdentityDigest: optOut.contactIdentityDigest,
      channel: optOut.channel,
      connectorAccountId: optOut.connectorAccountId,
      brandId: optOut.brandId,
      state: 'suppressed',
      winningFactId: optOut.factId,
      applicableFactIds: [optOut.factId],
      reducerVersion: 'contact-policy-v2',
      projectionVersion: 1,
      updatedAt: '2026-07-17T12:00:00.000Z',
    });

    await close(persistence, fact('reconsent', 'feedback-reconsent'));
    expect(persistence.projectedPolicy?.state).toBe('allowed');
    expect(persistence.projectedPolicy?.projectionVersion).toBe(2);
  });

  it('closes reply feedback into answered state', async () => {
    const persistence = new MemoryFeedbackPersistence();
    await close(persistence, fact('reply'));
    expect(persistence.answered).toBe(true);
  });

  it('rejects cross-account feedback projection substitution', async () => {
    const persistence = new MemoryFeedbackPersistence();
    vi.spyOn(persistence, 'loadProjectionState').mockResolvedValue({
      attempt,
      providerCorrelationDigest: CORRELATION_DIGEST,
      policyScope: {
        tenantId: attempt.tenantId,
        contactIdentityDigest: DIGEST,
        channel: 'sms',
        connectorAccountId:
          'account-attacker' as ContactChannelPolicy['connectorAccountId'],
        brandId: 'brand-redwood' as ContactChannelPolicy['brandId'],
      },
      policyFacts: [],
    });
    await expect(close(persistence, fact('opt_out'))).rejects.toThrow(
      'FEEDBACK_POLICY_SCOPE_MISMATCH',
    );
    expect(persistence.order).not.toContain('projection');
  });

  it('rejects cross-tenant feedback projection substitution', async () => {
    const persistence = new MemoryFeedbackPersistence();
    vi.spyOn(persistence, 'loadProjectionState').mockResolvedValue({
      attempt,
      providerCorrelationDigest: CORRELATION_DIGEST,
      policyScope: {
        tenantId: tenantIdSchema.parse('tenant-attacker'),
        contactIdentityDigest: DIGEST,
        channel: 'sms',
        connectorAccountId: account.accountId,
        brandId: 'brand-redwood' as ContactChannelPolicy['brandId'],
      },
      policyFacts: [],
    });
    await expect(close(persistence, fact('unsubscribe'))).rejects.toThrow(
      'FEEDBACK_POLICY_SCOPE_MISMATCH',
    );
    expect(persistence.order).not.toContain('projection');
  });
});

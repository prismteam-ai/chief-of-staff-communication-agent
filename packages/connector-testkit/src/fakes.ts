import type {
  FeedbackParseResult,
  ProviderSendResult,
} from '@chief/contracts/approval';
import type {
  NormalizedInboundEvent,
  VerifiedProviderEvent,
} from '@chief/contracts/connectors';
import { eventIdSchema } from '@chief/contracts/ids';
import type {
  CommunicationConnector,
  EffectArtifactAuthority,
  EffectExecutionPersistence,
  EffectReconciliationAuthority,
  FeedbackEventOutboxItem,
  FeedbackPersistence,
  FeedbackPublisher,
  FeedbackReplayItem,
  NoAuthorizationCommunicationConnector,
  PersistedEffectAttempt,
  VerifiedEventPersistence,
} from '@chief/connector-core';
import { assertCheckpointFence } from '@chief/connector-core';

import {
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_KEYED_DIGEST,
  FIXTURE_LATER,
  FIXTURE_NOW,
  type ConnectorContractFixtures,
} from './fixtures.js';

export interface DeterministicConnectorOptions {
  readonly malformedNormalization?: boolean;
  readonly sendResult?: ProviderSendResult;
  readonly reconcileResult?: ProviderSendResult;
  readonly omitReconciliation?: boolean;
  readonly omitSend?: boolean;
}

export interface DeterministicConnectorControl {
  readonly connector: CommunicationConnector;
  readonly calls: {
    readonly order: string[];
    sendCount: number;
    reconcileCount: number;
    subscriptionMutationCount: number;
    readonly subscriptionMethods: string[];
  };
}

export function createDeterministicConnector(
  fixtures: ConnectorContractFixtures,
  options: DeterministicConnectorOptions = {},
): DeterministicConnectorControl {
  const calls = {
    order: [] as string[],
    sendCount: 0,
    reconcileCount: 0,
    subscriptionMutationCount: 0,
    subscriptionMethods: [] as string[],
  };
  const sendResult: ProviderSendResult = options.sendResult ?? {
    outcome: 'accepted',
    providerResponseHash: FIXTURE_HASH,
    providerCorrelation: 'provider-message-a',
    observedAt: FIXTURE_LATER,
  };
  const reconcileResult = options.reconcileResult ?? sendResult;

  const base: NoAuthorizationCommunicationConnector = {
    connectorKind: 'communication',
    descriptor: () => fixtures.descriptor,
    authorizationStrategy: () => ({ strategy: 'none' }),
    validateConnection: (account) =>
      Promise.resolve({
        account,
        health: 'healthy',
        observedAt: FIXTURE_NOW,
        capabilitySnapshotHash: fixtures.snapshot.capabilitySnapshotHash,
      }),
    subscribe: () => {
      calls.subscriptionMutationCount += 1;
      calls.subscriptionMethods.push('subscribe');
      return Promise.resolve({
        providerReference: 'provider-subscription-a',
        providerResponseHash: FIXTURE_HASH,
        expiresAt: '2026-07-17T14:00:00.000Z',
        renewAfter: FIXTURE_LATER,
        observedAt: FIXTURE_NOW,
      });
    },
    renewSubscription: () => {
      calls.subscriptionMutationCount += 1;
      calls.subscriptionMethods.push('renew');
      return Promise.resolve({
        providerReference: 'provider-subscription-a',
        providerResponseHash: FIXTURE_HASH,
        expiresAt: '2026-07-17T14:00:00.000Z',
        renewAfter: FIXTURE_LATER,
        observedAt: FIXTURE_NOW,
      });
    },
    fetchMessage: (_account, ref) =>
      Promise.resolve({
        schemaVersion: '1',
        account: fixtures.accountRef,
        providerMessageRef: ref,
        sourceTimestamp: FIXTURE_NOW,
        rawBodyRef: 's3://private-fixture/message-a',
        canonicalPayloadHash: FIXTURE_HASH_B,
        attachmentCount: 0,
        connectorSnapshot: fixtures.snapshot,
      }),
    fetchThread: (_account, ref) =>
      Promise.resolve([
        {
          schemaVersion: '1',
          account: fixtures.accountRef,
          providerMessageRef: {
            providerMessageId: 'provider-message-a',
            providerThreadId: ref.providerThreadId,
          },
          sourceTimestamp: FIXTURE_NOW,
          rawBodyRef: 's3://private-fixture/message-a',
          canonicalPayloadHash: FIXTURE_HASH_B,
          attachmentCount: 0,
          connectorSnapshot: fixtures.snapshot,
        },
      ]),
    poll: (_account, request) => {
      assertCheckpointFence(request);
      return Promise.resolve({
        envelopes: [],
        sourceWatermark: 'watermark-1',
        complete: true,
        providerResponseHash: FIXTURE_HASH,
      });
    },
    verifyWebhook: (request) => {
      calls.order.push('verify');
      return request.headers['x-test-signature'] === 'valid'
        ? {
            verified: true,
            verificationMethod: 'deterministic-signature-v1',
            providerEventId: fixtures.verifiedEvent.providerEventId,
            rawPayloadDigest: fixtures.verifiedEvent.rawPayloadDigest,
          }
        : { verified: false, reasonCode: 'invalid_signature' };
    },
    normalizeInboundEvent: (event) => {
      calls.order.push('normalize');
      if (options.malformedNormalization === true) {
        return { schemaVersion: 'broken' } as unknown as NormalizedInboundEvent;
      }
      return {
        schemaVersion: '1',
        verifiedEvent: event,
        providerMessageId: 'provider-message-a',
        providerThreadId: 'provider-thread-a',
        sourceTimestamp: FIXTURE_NOW,
        canonicalPayloadHash: FIXTURE_HASH_B,
      };
    },
    parseFeedbackEvent: (event, context): FeedbackParseResult => ({
      kind: 'verified',
      fact: {
        schemaVersion: '1',
        tenantId: event.tenantId,
        feedbackFactId: eventIdSchema.parse('feedback-a'),
        providerEventId: event.providerEventId,
        providerMessageId: 'provider-message-a',
        providerCorrelation: context.knownOperationId,
        operationId: context.knownOperationId,
        attemptId: context.knownAttemptId,
        feedbackKind: 'delivered',
        providerTimestamp: FIXTURE_LATER,
        rawEventRef: event.rawEventRef,
        rawPayloadDigest: event.rawPayloadDigest,
        connectorSnapshot: context.connectorSnapshot,
        idempotencyDigest: FIXTURE_KEYED_DIGEST,
      },
    }),
    send: (_account, artifact) => {
      calls.order.push('send');
      calls.sendCount += 1;
      if (
        artifact.connectorSnapshot.capabilitySnapshotHash !==
          fixtures.snapshot.capabilitySnapshotHash ||
        artifact.actionPlanHash !== fixtures.artifact.actionPlanHash ||
        artifact.approvalId !== fixtures.artifact.approvalId
      ) {
        throw new Error('ARTIFACT_REVISION_REJECTED');
      }
      return Promise.resolve(sendResult);
    },
    reconcileSend: (_account, request) => {
      calls.reconcileCount += 1;
      if (
        request.artifact.operationId !== fixtures.artifact.operationId ||
        request.priorAttemptId !== fixtures.artifact.attemptId ||
        request.strategy !== fixtures.artifact.reconciliationStrategy ||
        request.strategyVersion !==
          fixtures.artifact.reconciliationStrategyVersion
      ) {
        throw new Error('RECONCILIATION_REQUEST_REJECTED');
      }
      return Promise.resolve(reconcileResult);
    },
  };

  if (options.omitSend === true) {
    delete (base as Partial<NoAuthorizationCommunicationConnector>).send;
  }
  if (options.omitReconciliation === true) {
    delete (base as Partial<NoAuthorizationCommunicationConnector>)
      .reconcileSend;
  }
  return { connector: base, calls };
}

export class InMemoryEffectPersistence implements EffectExecutionPersistence {
  public readonly attempts = new Map<string, PersistedEffectAttempt>();
  public failAcceptedPersistenceOnce = false;
  readonly #reconciliationClaims = new Set<string>();

  public prepareConditionally(artifact: ConnectorContractFixtures['artifact']) {
    const existing = this.attempts.get(artifact.operationId);
    if (existing !== undefined) {
      return Promise.resolve({
        status: 'existing' as const,
        attempt: existing,
      });
    }
    const attempt: PersistedEffectAttempt = {
      operationId: artifact.operationId,
      attemptId: artifact.attemptId,
      lifecycle: 'prepared',
      transportState: 'queued',
      clientCorrelation: artifact.clientCorrelation,
      correlationBindingVersion: artifact.correlationBindingVersion,
    };
    this.attempts.set(artifact.operationId, attempt);
    return Promise.resolve({ status: 'created' as const, attempt });
  }

  public claimDispatchConditionally(
    artifact: ConnectorContractFixtures['artifact'],
  ) {
    const current = this.attempts.get(artifact.operationId);
    if (current === undefined || current.lifecycle !== 'prepared') {
      return Promise.resolve({
        status: 'contended' as const,
        attempt:
          current ??
          this.store(artifact, {
            lifecycle: 'reconciliation_required',
            transportState: 'acceptance_unknown',
          }),
      });
    }
    return Promise.resolve({
      status: 'claimed' as const,
      attempt: this.store(artifact, {
        lifecycle: 'dispatching',
        transportState: 'queued',
      }),
    });
  }

  public releaseUncalledClaimConditionally(
    artifact: ConnectorContractFixtures['artifact'],
  ) {
    const current = this.attempts.get(artifact.operationId);
    if (current === undefined || current.lifecycle !== 'dispatching') {
      throw new Error('dispatch claim compare-and-swap failed');
    }
    return Promise.resolve(
      this.store(artifact, {
        lifecycle: 'prepared',
        transportState: 'queued',
      }),
    );
  }

  public claimReconciliationConditionally(
    artifact: ConnectorContractFixtures['artifact'],
  ) {
    const current = this.attempts.get(artifact.operationId);
    if (
      current === undefined ||
      current.transportState !== 'acceptance_unknown' ||
      this.#reconciliationClaims.has(artifact.operationId)
    ) {
      return Promise.resolve({
        status: 'contended' as const,
        attempt:
          current ??
          this.store(artifact, {
            lifecycle: 'reconciliation_required',
            transportState: 'acceptance_unknown',
          }),
      });
    }
    this.#reconciliationClaims.add(artifact.operationId);
    return Promise.resolve({ status: 'claimed' as const, attempt: current });
  }

  public releaseReconciliationClaimConditionally(
    artifact: ConnectorContractFixtures['artifact'],
  ) {
    if (!this.#reconciliationClaims.delete(artifact.operationId)) {
      throw new Error('reconciliation claim compare-and-swap failed');
    }
    const current = this.attempts.get(artifact.operationId);
    if (current === undefined) {
      throw new Error('reconciliation attempt does not exist');
    }
    return Promise.resolve(current);
  }

  public settleRejected(artifact: ConnectorContractFixtures['artifact']) {
    this.#reconciliationClaims.delete(artifact.operationId);
    return Promise.resolve(
      this.store(artifact, {
        lifecycle: 'settled',
        transportState: 'provider_rejected',
      }),
    );
  }

  public settleAcceptedAndBindCorrelation(
    artifact: ConnectorContractFixtures['artifact'],
    _result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ) {
    if (this.failAcceptedPersistenceOnce) {
      this.failAcceptedPersistenceOnce = false;
      throw new Error('injected correlation persistence failure');
    }
    this.#reconciliationClaims.delete(artifact.operationId);
    return Promise.resolve(
      this.store(artifact, {
        lifecycle: 'settled',
        transportState: 'provider_accepted',
        providerCorrelationDigest: FIXTURE_KEYED_DIGEST,
      }),
    );
  }

  public freezeAcceptanceUnknown(
    artifact: ConnectorContractFixtures['artifact'],
  ) {
    this.#reconciliationClaims.delete(artifact.operationId);
    return Promise.resolve(
      this.store(artifact, {
        lifecycle: 'reconciliation_required',
        transportState: 'acceptance_unknown',
      }),
    );
  }

  private store(
    artifact: ConnectorContractFixtures['artifact'],
    state: Pick<PersistedEffectAttempt, 'lifecycle' | 'transportState'> &
      Partial<Pick<PersistedEffectAttempt, 'providerCorrelationDigest'>>,
  ): PersistedEffectAttempt {
    const attempt: PersistedEffectAttempt = {
      operationId: artifact.operationId,
      attemptId: artifact.attemptId,
      clientCorrelation: artifact.clientCorrelation,
      correlationBindingVersion: artifact.correlationBindingVersion,
      ...state,
    };
    this.attempts.set(artifact.operationId, attempt);
    return attempt;
  }
}

export class ExactFixtureArtifactAuthority implements EffectArtifactAuthority {
  public constructor(
    private readonly expected: ConnectorContractFixtures['artifact'],
  ) {}

  public assertCurrent(
    artifact: ConnectorContractFixtures['artifact'],
  ): Promise<void> {
    if (
      artifact.tenantId !== this.expected.tenantId ||
      artifact.operationId !== this.expected.operationId ||
      artifact.attemptId !== this.expected.attemptId ||
      artifact.actionPlanId !== this.expected.actionPlanId ||
      artifact.actionPlanHash !== this.expected.actionPlanHash ||
      artifact.approvalId !== this.expected.approvalId ||
      artifact.draftRevisionId !== this.expected.draftRevisionId ||
      artifact.renderedPayloadFingerprint !==
        this.expected.renderedPayloadFingerprint
    ) {
      throw new Error('STALE_EFFECT_ARTIFACT_REVISION');
    }
    return Promise.resolve();
  }
}

export class ExactFixtureReconciliationAuthority implements EffectReconciliationAuthority {
  public constructor(
    private readonly expected: ConnectorContractFixtures['artifact'],
  ) {}

  public assertReadableForReconciliation(
    account: ConnectorContractFixtures['accountRef'],
    artifact: ConnectorContractFixtures['artifact'],
  ): Promise<void> {
    if (
      account.tenantId !== this.expected.tenantId ||
      account.accountId !== this.expected.account.accountId ||
      artifact.tenantId !== this.expected.tenantId ||
      artifact.operationId !== this.expected.operationId ||
      artifact.attemptId !== this.expected.attemptId ||
      artifact.stableIdempotencyKey !== this.expected.stableIdempotencyKey ||
      artifact.sourceMessageRevisionId !==
        this.expected.sourceMessageRevisionId ||
      artifact.actionPlanId !== this.expected.actionPlanId ||
      artifact.actionPlanHash !== this.expected.actionPlanHash ||
      artifact.approvalId !== this.expected.approvalId ||
      artifact.draftRevisionId !== this.expected.draftRevisionId ||
      artifact.renderedPayloadFingerprint !==
        this.expected.renderedPayloadFingerprint ||
      artifact.connectorSnapshot.capabilitySnapshotHash !==
        this.expected.connectorSnapshot.capabilitySnapshotHash ||
      artifact.correlationBindingVersion !==
        this.expected.correlationBindingVersion ||
      artifact.reconciliationStrategy !==
        this.expected.reconciliationStrategy ||
      artifact.reconciliationStrategyVersion !==
        this.expected.reconciliationStrategyVersion
    ) {
      throw new Error('RECONCILIATION_READ_ACCESS_REJECTED');
    }
    return Promise.resolve();
  }
}

export class InMemoryFeedbackPersistence implements FeedbackPersistence {
  public readonly facts = new Map<string, FeedbackEventOutboxItem>();
  public readonly outbox = new Map<string, FeedbackEventOutboxItem>();
  public readonly replay = new Map<string, FeedbackReplayItem>();
  public failAtomicWriteOnce = false;

  public persistFactAndOutbox(
    fact: Parameters<FeedbackPersistence['persistFactAndOutbox']>[0],
    outbox: FeedbackEventOutboxItem,
  ): Promise<'created' | 'duplicate'> {
    if (this.failAtomicWriteOnce) {
      this.failAtomicWriteOnce = false;
      throw new Error('injected transaction cancellation');
    }
    if (this.facts.has(fact.feedbackFactId)) {
      return Promise.resolve('duplicate');
    }
    this.facts.set(fact.feedbackFactId, outbox);
    this.outbox.set(outbox.eventId, outbox);
    return Promise.resolve('created');
  }

  public persistReplay(item: FeedbackReplayItem): Promise<void> {
    this.replay.set(item.replayId, item);
    return Promise.resolve();
  }
}

export class RecordingFeedbackPublisher implements FeedbackPublisher {
  public readonly published: FeedbackEventOutboxItem[] = [];

  public publish(item: FeedbackEventOutboxItem): Promise<void> {
    this.published.push(item);
    return Promise.resolve();
  }
}

export class RecordingVerifiedEventPersistence implements VerifiedEventPersistence {
  public readonly calls: string[] = [];

  public constructor(
    private readonly event: VerifiedProviderEvent,
    private readonly sharedOrder?: string[],
  ) {}

  public persistVerifiedEvent(): Promise<VerifiedProviderEvent> {
    this.calls.push('persist_verified');
    this.sharedOrder?.push('persist_verified');
    return Promise.resolve(this.event);
  }
}

import { sendAttemptSchema } from '@chief/contracts/approval';
import type {
  FeedbackContext,
  FeedbackParseResult,
  VerifiedFeedbackFact,
} from '@chief/contracts/approval';
import {
  connectionHealthSchema,
  connectorSnapshotSchema,
  workObjectFactSchema,
} from '@chief/contracts/connectors';
import {
  accountIdSchema,
  keyedDigestValueSchema,
  attemptIdSchema,
  tenantIdSchema,
} from '@chief/contracts/ids';
import type {
  CommunicationConnector,
  WorkManagementConnector,
} from '@chief/connector-core';
import {
  assertCheckpointFence,
  communicationConnectorIssues,
  ConnectorRuntimeRegistry,
  dispatchCommunicationEffect,
  dispatchWorkManagementEffect,
  fetchCommunicationMessage,
  fetchCommunicationThread,
  pollCommunicationConnector,
  processFeedback,
  reconcileCommunicationEffect,
  reconcileWorkManagementEffect,
  invokeCommunicationSubscriptionMutation,
  invokeWorkManagementSubscriptionMutation,
  UnknownAcceptanceRetryError,
  verifyAndNormalizeWebhook,
} from '@chief/connector-core';
import {
  applyTransportFact,
  assertOrdinaryRetryAllowed,
} from '@chief/domain/transport-state';
import { advanceSyncCheckpoint } from '@chief/domain/connector-state';

import {
  createDeterministicConnector,
  ExactFixtureArtifactAuthority,
  ExactFixtureReconciliationAuthority,
  InMemoryEffectPersistence,
  InMemoryFeedbackPersistence,
  RecordingFeedbackPublisher,
  RecordingVerifiedEventPersistence,
} from './fakes.js';
import {
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_LATER,
  FIXTURE_NOW,
  type ConnectorContractFixtures,
} from './fixtures.js';

export interface ConnectorContractCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface ConnectorContractReport {
  readonly connectorId: string;
  readonly checks: readonly ConnectorContractCheck[];
  readonly passed: boolean;
}

async function runCheck(
  name: string,
  check: () => void | Promise<void>,
): Promise<ConnectorContractCheck> {
  try {
    await check();
    return { name, passed: true };
  } catch (error) {
    return {
      name,
      passed: false,
      detail: error instanceof Error ? error.message : 'unknown failure',
    };
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function authority(fixtures: ConnectorContractFixtures) {
  return new ExactFixtureArtifactAuthority(fixtures.artifact);
}

function reconciliationAuthority(fixtures: ConnectorContractFixtures) {
  return new ExactFixtureReconciliationAuthority(fixtures.artifact);
}

export async function runCommunicationConnectorContract(
  connector: CommunicationConnector,
  fixtures: ConnectorContractFixtures,
): Promise<ConnectorContractReport> {
  const checks: ConnectorContractCheck[] = [];
  const capabilities = connector.descriptor().capabilities;
  checks.push(
    await runCheck('descriptor and method parity', () => {
      const issues = communicationConnectorIssues(connector);
      assert(issues.length === 0, issues.join('; '));
    }),
  );
  checks.push(
    await runCheck(
      'normalized webhooks retain persisted identity bindings',
      async () => {
        if (!capabilities.webhook) {
          return;
        }
        const persistence = new RecordingVerifiedEventPersistence(
          fixtures.verifiedEvent,
        );
        assert(
          connector.verifyWebhook !== undefined,
          'webhook verifier is unavailable',
        );
        const substituted = {
          descriptor: () => connector.descriptor(),
          verifyWebhook: (request: typeof fixtures.webhookRequest) => {
            if (connector.verifyWebhook === undefined) {
              throw new Error('webhook verifier is unavailable');
            }
            return connector.verifyWebhook(request);
          },
          normalizeInboundEvent: (event: typeof fixtures.verifiedEvent) => ({
            schemaVersion: '1' as const,
            verifiedEvent: {
              ...event,
              providerEventId: 'provider-event-substituted',
            },
            providerMessageId: 'provider-message-a',
            sourceTimestamp: FIXTURE_NOW,
            canonicalPayloadHash: FIXTURE_HASH,
          }),
        } as unknown as CommunicationConnector;
        let rejected = false;
        try {
          await verifyAndNormalizeWebhook(
            substituted,
            persistence,
            fixtures.webhookRequest,
          );
        } catch (error) {
          rejected =
            error instanceof Error &&
            error.message === 'NORMALIZED_EVENT_BINDING_MISMATCH';
        }
        assert(
          rejected,
          'schema-valid webhook identity substitution was accepted',
        );
        assert(
          persistence.calls.length === 1,
          'verified provider input was not durably recorded before normalization',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'webhook verification precedes persistence and normalization',
      async () => {
        const persistence = new RecordingVerifiedEventPersistence(
          fixtures.verifiedEvent,
        );
        if (!capabilities.webhook) {
          assert(
            connector.verifyWebhook === undefined,
            'webhook verifier exists without the webhook capability',
          );
          let rejected = false;
          try {
            await verifyAndNormalizeWebhook(
              connector,
              persistence,
              fixtures.webhookRequest,
            );
          } catch (error) {
            rejected =
              error instanceof Error &&
              error.message === 'WEBHOOK_CAPABILITY_NOT_AVAILABLE';
          }
          assert(rejected, 'disabled webhook path did not fail closed');
          assert(
            persistence.calls.length === 0,
            'disabled webhook path persisted provider input',
          );
          return;
        }
        const result = await verifyAndNormalizeWebhook(
          connector,
          persistence,
          fixtures.webhookRequest,
        );
        assert(result.status === 'normalized', 'webhook was not normalized');
        assert(
          persistence.calls.join(',') === 'persist_verified',
          'verified event was not persisted exactly once',
        );
        assert(
          result.event.verifiedEvent.providerEventId ===
            fixtures.verifiedEvent.providerEventId,
          'normalization did not consume the persisted verified event',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'checkpoint path is fenced and capability-bound',
      async () => {
        if (!capabilities.poll) {
          assert(
            connector.poll === undefined,
            'poll exists without capability',
          );
          let rejected = false;
          try {
            await pollCommunicationConnector(
              connector,
              fixtures.accountRef,
              fixtures.pollRequest,
            );
          } catch (error) {
            rejected =
              error instanceof Error &&
              error.message === 'POLL_CAPABILITY_NOT_AVAILABLE';
          }
          assert(rejected, 'disabled poll path did not fail closed');
          return;
        }
        let rejected = false;
        try {
          assertCheckpointFence({
            ...fixtures.pollRequest,
            expectedCheckpointEpoch:
              fixtures.pollRequest.expectedCheckpointEpoch + 1,
          });
        } catch {
          rejected = true;
        }
        assert(rejected, 'stale checkpoint was accepted');
        let prematureAdvanceRejected = false;
        try {
          advanceSyncCheckpoint({
            actorTenantId: fixtures.pollRequest.checkpoint.tenantId,
            checkpoint: fixtures.pollRequest.checkpoint,
            expectedCheckpointEpoch:
              fixtures.pollRequest.checkpoint.checkpointEpoch,
            encryptedCursor: 'encrypted:next-cursor',
            sourceWatermark: 'watermark-1',
            completePage: 1,
            canonicalWritesCommitted: true,
            eventOutboxCommitted: false,
            committedAt: FIXTURE_LATER,
          });
        } catch {
          prematureAdvanceRejected = true;
        }
        assert(
          prematureAdvanceRejected,
          'checkpoint advanced before canonical writes and outbox were committed',
        );
        await pollCommunicationConnector(
          connector,
          fixtures.accountRef,
          fixtures.pollRequest,
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'subscription provider invocation is fenced immediately before call',
      async () => {
        if (!capabilities.webhook) {
          let unavailable = false;
          try {
            await invokeCommunicationSubscriptionMutation(
              connector,
              fixtures.subscriptionRequest,
              FIXTURE_NOW,
            );
          } catch (error) {
            unavailable =
              error instanceof Error &&
              error.message === 'SUBSCRIPTION_CAPABILITY_NOT_AVAILABLE';
          }
          assert(unavailable, 'disabled subscription path did not fail closed');
        }
        const control = createDeterministicConnector(fixtures);
        let staleRejected = false;
        try {
          await invokeCommunicationSubscriptionMutation(
            control.connector,
            {
              ...fixtures.subscriptionRequest,
              mutationClaim: {
                ...fixtures.subscriptionRequest.mutationClaim,
                expiresAt: FIXTURE_NOW,
              },
            },
            FIXTURE_NOW,
          );
        } catch (error) {
          staleRejected =
            error instanceof Error &&
            error.message === 'SUBSCRIPTION_MUTATION_FENCE_REJECTED';
        }
        assert(staleRejected, 'stale subscription claim was accepted');
        assert(
          control.calls.subscriptionMutationCount === 0,
          'stale subscription claim called the adapter',
        );
        await invokeCommunicationSubscriptionMutation(
          control.connector,
          fixtures.subscriptionRequest,
          FIXTURE_NOW,
        );
        assert(
          Number(control.calls.subscriptionMutationCount) === 1,
          'valid subscription claim did not call the adapter exactly once',
        );
        assert(
          control.calls.subscriptionMethods.join(',') === 'subscribe',
          'create subscription mutation selected the wrong provider method',
        );
      },
    ),
  );
  checks.push(
    await runCheck('adapters return canonical provider facts', async () => {
      const health = connectionHealthSchema.parse(
        await connector.validateConnection(fixtures.accountRef),
      );
      assert(
        health.account.tenantId === fixtures.accountRef.tenantId &&
          health.account.accountId === fixtures.accountRef.accountId &&
          health.account.expectedStateVersion ===
            fixtures.accountRef.expectedStateVersion &&
          health.capabilitySnapshotHash ===
            fixtures.snapshot.capabilitySnapshotHash,
        'connection health substituted account or capability bindings',
      );
      if (capabilities.read) {
        await fetchCommunicationMessage(connector, fixtures.account, {
          providerMessageId: 'provider-message-a',
        });
      } else {
        assert(
          connector.fetchMessage === undefined,
          'message fetch exists without read capability',
        );
        let rejected = false;
        try {
          await fetchCommunicationMessage(connector, fixtures.account, {
            providerMessageId: 'provider-message-a',
          });
        } catch (error) {
          rejected =
            error instanceof Error &&
            error.message === 'READ_CAPABILITY_NOT_AVAILABLE';
        }
        assert(rejected, 'disabled read path did not fail closed');
      }
      if (capabilities.threads) {
        await fetchCommunicationThread(connector, fixtures.account, {
          providerThreadId: 'provider-thread-a',
        });
      } else {
        assert(
          connector.fetchThread === undefined,
          'thread fetch exists without capability',
        );
        let rejected = false;
        try {
          await fetchCommunicationThread(connector, fixtures.account, {
            providerThreadId: 'provider-thread-a',
          });
        } catch (error) {
          rejected =
            error instanceof Error &&
            error.message === 'THREAD_CAPABILITY_NOT_AVAILABLE';
        }
        assert(rejected, 'disabled thread path did not fail closed');
      }
    }),
  );
  checks.push(
    await runCheck(
      'effect artifact and capability snapshot are current',
      async () => {
        const persistence = new InMemoryEffectPersistence();
        if (!capabilities.send || !capabilities.externalEffect) {
          assert(
            connector.send === undefined &&
              connector.reconcileSend === undefined,
            'effect methods exist without send capability',
          );
          let rejected = false;
          try {
            await dispatchCommunicationEffect(
              connector,
              persistence,
              authority(fixtures),
              fixtures.accountRef,
              fixtures.artifact,
              fixtures.snapshot,
            );
          } catch (error) {
            rejected =
              error instanceof Error &&
              error.message === 'CONNECTOR_SEND_CAPABILITY_DISABLED';
          }
          assert(rejected, 'disabled effect path did not fail closed');
          assert(
            persistence.attempts.size === 0,
            'disabled effect path wrote an execution attempt',
          );
          let reconciliationRejected = false;
          try {
            await reconcileCommunicationEffect(
              connector,
              persistence,
              reconciliationAuthority(fixtures),
              fixtures.accountRef,
              fixtures.reconcileRequest,
              fixtures.snapshot,
            );
          } catch (error) {
            reconciliationRejected =
              error instanceof Error &&
              error.message === 'COMMUNICATION_RECONCILIATION_UNAVAILABLE';
          }
          assert(
            reconciliationRejected,
            'disabled reconciliation path did not fail closed',
          );
          assert(
            persistence.attempts.size === 0,
            'disabled reconciliation path wrote an execution attempt',
          );
          return;
        }
        const drifted = connectorSnapshotSchema.parse({
          ...fixtures.snapshot,
          capabilitySnapshotHash: FIXTURE_HASH_B,
        });
        let driftRejected = false;
        try {
          await dispatchCommunicationEffect(
            connector,
            persistence,
            authority(fixtures),
            fixtures.accountRef,
            fixtures.artifact,
            drifted,
          );
        } catch {
          driftRejected = true;
        }
        assert(driftRejected, 'capability drift was accepted');

        let staleRevisionRejected = false;
        try {
          await dispatchCommunicationEffect(
            connector,
            persistence,
            authority(fixtures),
            fixtures.accountRef,
            { ...fixtures.artifact, actionPlanHash: FIXTURE_HASH_B },
            fixtures.snapshot,
          );
        } catch {
          staleRevisionRejected = true;
        }
        assert(
          staleRevisionRejected,
          'stale action-plan revision was accepted',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'correlation persists before provider acceptance',
      async () => {
        if (!capabilities.send || !capabilities.externalEffect) {
          return;
        }
        const persistence = new InMemoryEffectPersistence();
        const result = await dispatchCommunicationEffect(
          connector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(result.status === 'settled', 'effect did not settle');
        assert(
          result.attempt.transportState === 'provider_accepted',
          'provider acceptance was not persisted',
        );
        assert(
          result.attempt.providerCorrelationDigest !== undefined,
          'provider acceptance persisted without a keyed correlation digest',
        );
        keyedDigestValueSchema.parse(result.attempt.providerCorrelationDigest);
        assert(
          !Object.hasOwn(result.attempt, 'providerCorrelation'),
          'raw provider correlation leaked into persisted attempt',
        );
        assert(
          result.attempt.clientCorrelation.value ===
            fixtures.artifact.clientCorrelation.value,
          'internal client correlation was not persisted before acceptance',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'post-call correlation failure freezes acceptance unknown',
      async () => {
        if (!capabilities.send || !capabilities.externalEffect) {
          return;
        }
        const persistence = new InMemoryEffectPersistence();
        persistence.failAcceptedPersistenceOnce = true;
        const result = await dispatchCommunicationEffect(
          connector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(
          result.status === 'reconciliation_required' &&
            result.attempt.transportState === 'acceptance_unknown',
          'correlation failure did not freeze the operation',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'duplicate effects do not call the adapter twice',
      async () => {
        const control = createDeterministicConnector(fixtures);
        const persistence = new InMemoryEffectPersistence();
        await persistence.prepareConditionally(fixtures.artifact);
        await dispatchCommunicationEffect(
          control.connector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        const duplicate = await dispatchCommunicationEffect(
          control.connector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(duplicate.status === 'duplicate', 'duplicate was not detected');
        assert(
          control.calls.sendCount === 1,
          'adapter was called more than once',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'acceptance unknown only exits through guarded reconciliation',
      async () => {
        const control = createDeterministicConnector(fixtures, {
          sendResult: {
            outcome: 'acceptance_unknown',
            reasonCode: 'timeout_after_dispatch',
            observedAt: FIXTURE_LATER,
          },
          reconcileResult: {
            outcome: 'accepted',
            providerResponseHash: FIXTURE_HASH,
            providerCorrelation: 'provider-message-reconciled',
            observedAt: FIXTURE_LATER,
          },
        });
        const unknownConnector = control.connector;
        const persistence = new InMemoryEffectPersistence();
        await dispatchCommunicationEffect(
          unknownConnector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        let refused = false;
        try {
          await dispatchCommunicationEffect(
            unknownConnector,
            persistence,
            authority(fixtures),
            fixtures.accountRef,
            fixtures.artifact,
            fixtures.snapshot,
          );
        } catch (error) {
          refused = error instanceof UnknownAcceptanceRetryError;
        }
        assert(refused, 'acceptance-unknown operation entered ordinary retry');

        let priorAttemptRejected = false;
        try {
          await reconcileCommunicationEffect(
            unknownConnector,
            persistence,
            reconciliationAuthority(fixtures),
            fixtures.accountRef,
            {
              ...fixtures.reconcileRequest,
              priorAttemptId: attemptIdSchema.parse('attempt-stale'),
            },
            fixtures.snapshot,
          );
        } catch (error) {
          priorAttemptRejected =
            error instanceof Error &&
            error.message === 'RECONCILIATION_REQUEST_BINDING_MISMATCH';
        }
        assert(priorAttemptRejected, 'mismatched prior attempt was reconciled');

        let staleArtifactRejected = false;
        try {
          await reconcileCommunicationEffect(
            unknownConnector,
            persistence,
            reconciliationAuthority(fixtures),
            fixtures.accountRef,
            {
              ...fixtures.reconcileRequest,
              artifact: {
                ...fixtures.reconcileRequest.artifact,
                actionPlanHash: FIXTURE_HASH_B,
              },
            },
            fixtures.snapshot,
          );
        } catch (error) {
          staleArtifactRejected =
            error instanceof Error &&
            error.message === 'RECONCILIATION_READ_ACCESS_REJECTED';
        }
        assert(staleArtifactRejected, 'stale reconciliation artifact was used');
        assert(
          control.calls.reconcileCount === 0,
          'invalid reconciliation request called the adapter',
        );

        let deniedReadRejected = false;
        try {
          await reconcileCommunicationEffect(
            unknownConnector,
            persistence,
            {
              assertReadableForReconciliation: () =>
                Promise.reject(
                  new Error('RECONCILIATION_READ_ACCESS_REJECTED'),
                ),
            },
            fixtures.accountRef,
            fixtures.reconcileRequest,
            fixtures.snapshot,
          );
        } catch (error) {
          deniedReadRejected =
            error instanceof Error &&
            error.message === 'RECONCILIATION_READ_ACCESS_REJECTED';
        }
        assert(deniedReadRejected, 'reconciliation read denial was ignored');
        assert(
          control.calls.reconcileCount === 0,
          'denied reconciliation read called the adapter',
        );

        const heldClaim = await persistence.claimReconciliationConditionally(
          fixtures.artifact,
        );
        assert(
          heldClaim.status === 'claimed',
          'test reconciliation claim failed',
        );
        const contended = await reconcileCommunicationEffect(
          unknownConnector,
          persistence,
          reconciliationAuthority(fixtures),
          fixtures.accountRef,
          fixtures.reconcileRequest,
          fixtures.snapshot,
        );
        assert(
          contended.status === 'contended',
          'reconciliation contention lost',
        );
        assert(
          control.calls.reconcileCount === 0,
          'contended reconciliation called the adapter',
        );
        await persistence.releaseReconciliationClaimConditionally(
          fixtures.artifact,
        );

        let effectAuthorityConsulted = 0;
        const readAuthority = reconciliationAuthority(fixtures);
        const reconciliationOnlyAuthority = {
          assertCurrent: () => {
            effectAuthorityConsulted += 1;
            return Promise.reject(new Error('EFFECT_AUTHORIZATION_REVOKED'));
          },
          assertReadableForReconciliation: (
            account: typeof fixtures.accountRef,
            artifact: typeof fixtures.artifact,
          ) => readAuthority.assertReadableForReconciliation(account, artifact),
        };
        const accepted = await reconcileCommunicationEffect(
          unknownConnector,
          persistence,
          reconciliationOnlyAuthority,
          fixtures.accountRef,
          fixtures.reconcileRequest,
          fixtures.snapshot,
        );
        assert(
          accepted.status === 'settled' &&
            accepted.attempt.transportState === 'provider_accepted' &&
            accepted.attempt.providerCorrelationDigest !== undefined,
          'accepted reconciliation did not persist keyed correlation first',
        );
        keyedDigestValueSchema.parse(
          accepted.attempt.providerCorrelationDigest,
        );
        assert(
          !Object.hasOwn(accepted.attempt, 'providerCorrelation'),
          'accepted reconciliation persisted raw provider correlation',
        );
        assert(
          effectAuthorityConsulted === 0,
          'effect authority was consulted during read-only reconciliation',
        );

        const rejectedControl = createDeterministicConnector(fixtures, {
          sendResult: {
            outcome: 'acceptance_unknown',
            reasonCode: 'timeout_after_dispatch',
            observedAt: FIXTURE_LATER,
          },
          reconcileResult: {
            outcome: 'rejected',
            providerResponseHash: FIXTURE_HASH_B,
            reasonCode: 'provider_confirms_absent',
            observedAt: FIXTURE_LATER,
          },
        });
        const rejectedPersistence = new InMemoryEffectPersistence();
        await dispatchCommunicationEffect(
          rejectedControl.connector,
          rejectedPersistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        const rejected = await reconcileCommunicationEffect(
          rejectedControl.connector,
          rejectedPersistence,
          reconciliationAuthority(fixtures),
          fixtures.accountRef,
          fixtures.reconcileRequest,
          fixtures.snapshot,
        );
        assert(
          rejected.status === 'settled' &&
            rejected.attempt.transportState === 'provider_rejected',
          'provider-rejected reconciliation did not settle safely',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'feedback fact and event outbox persist before publication',
      async () => {
        if (!capabilities.deliveryFeedback) {
          assert(
            connector.parseFeedbackEvent === undefined,
            'feedback parser exists without capability',
          );
          return;
        }
        assert(
          connector.parseFeedbackEvent !== undefined,
          'feedback parser is unavailable',
        );
        const persistence = new InMemoryFeedbackPersistence();
        const publisher = new RecordingFeedbackPublisher();
        const result = await processFeedback(
          { parseFeedbackEvent: connector.parseFeedbackEvent.bind(connector) },
          persistence,
          publisher,
          fixtures.verifiedEvent,
          fixtures.feedbackContext,
          FIXTURE_NOW,
        );
        assert(result.status === 'persisted', 'feedback was not persisted');
        assert(persistence.facts.size === 1, 'feedback fact missing');
        assert(persistence.outbox.size === 1, 'feedback outbox missing');
        assert(publisher.published.length === 1, 'feedback was not published');

        const duplicate = await processFeedback(
          { parseFeedbackEvent: connector.parseFeedbackEvent.bind(connector) },
          persistence,
          publisher,
          fixtures.verifiedEvent,
          fixtures.feedbackContext,
          FIXTURE_NOW,
        );
        assert(
          duplicate.status === 'duplicate',
          'feedback duplicate was recreated',
        );
        assert(
          publisher.published.length === 1,
          'duplicate feedback was republished',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'feedback bindings reject adapter substitution before writes',
      async () => {
        if (!capabilities.deliveryFeedback) {
          return;
        }
        assert(
          connector.parseFeedbackEvent !== undefined,
          'feedback parser is unavailable',
        );
        const parsed = connector.parseFeedbackEvent(
          fixtures.verifiedEvent,
          fixtures.feedbackContext,
        );
        assert(parsed.kind === 'verified', 'fixture feedback was not verified');
        const substitutions: readonly VerifiedFeedbackFact[] = [
          {
            ...parsed.fact,
            tenantId: tenantIdSchema.parse('tenant-substituted'),
          },
          {
            ...parsed.fact,
            connectorSnapshot: {
              ...parsed.fact.connectorSnapshot,
              accountId: accountIdSchema.parse('account-substituted'),
            },
          },
          { ...parsed.fact, rawPayloadDigest: FIXTURE_HASH_B },
        ];
        for (const fact of substitutions) {
          const persistence = new InMemoryFeedbackPersistence();
          const publisher = new RecordingFeedbackPublisher();
          let rejected = false;
          try {
            await processFeedback(
              {
                parseFeedbackEvent: () => ({ kind: 'verified', fact }),
              },
              persistence,
              publisher,
              fixtures.verifiedEvent,
              fixtures.feedbackContext,
              FIXTURE_NOW,
            );
          } catch (error) {
            rejected =
              error instanceof Error &&
              error.message === 'FEEDBACK_BINDING_MISMATCH';
          }
          assert(rejected, 'schema-valid feedback substitution was accepted');
          assert(
            persistence.facts.size === 0 &&
              persistence.outbox.size === 0 &&
              persistence.replay.size === 0 &&
              publisher.published.length === 0,
            'rejected feedback substitution produced a durable or published effect',
          );
        }
      },
    ),
  );
  checks.push(
    await runCheck(
      'uncorrelated and failed feedback remain durable replay work',
      async () => {
        if (!capabilities.deliveryFeedback) {
          return;
        }
        assert(
          connector.parseFeedbackEvent !== undefined,
          'feedback parser is unavailable',
        );
        const parsed = connector.parseFeedbackEvent(
          fixtures.verifiedEvent,
          fixtures.feedbackContext,
        );
        assert(parsed.kind === 'verified', 'fixture feedback was not verified');
        const uncorrelatedFact: VerifiedFeedbackFact = {
          ...parsed.fact,
          operationId: undefined,
          attemptId: undefined,
        };
        const uncorrelatedAdapter = {
          parseFeedbackEvent: (): FeedbackParseResult => ({
            kind: 'verified',
            fact: uncorrelatedFact,
          }),
        };
        const persistence = new InMemoryFeedbackPersistence();
        const publisher = new RecordingFeedbackPublisher();
        const uncorrelatedContext: FeedbackContext = {
          tenantId: fixtures.feedbackContext.tenantId,
          account: fixtures.feedbackContext.account,
          connectorSnapshot: fixtures.feedbackContext.connectorSnapshot,
        };
        const result = await processFeedback(
          uncorrelatedAdapter,
          persistence,
          publisher,
          fixtures.verifiedEvent,
          uncorrelatedContext,
          FIXTURE_NOW,
        );
        assert(
          result.status === 'pending_replay',
          'uncorrelated fact was dropped',
        );

        persistence.failAtomicWriteOnce = true;
        const failed = await processFeedback(
          { parseFeedbackEvent: connector.parseFeedbackEvent.bind(connector) },
          persistence,
          publisher,
          fixtures.verifiedEvent,
          fixtures.feedbackContext,
          FIXTURE_NOW,
        );
        assert(
          failed.status === 'pending_replay',
          'failed write was not replayable',
        );
        assert(
          persistence.replay.size === 2,
          'durable replay records are incomplete',
        );
        assert(
          publisher.published.length === 0,
          'unpersisted feedback was published',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'canonical transport lattice rejects unsafe transitions',
      () => {
        const attempt = sendAttemptSchema.parse({
          schemaVersion: '1',
          tenantId: fixtures.accountRef.tenantId,
          operationId: fixtures.artifact.operationId,
          attemptId: fixtures.artifact.attemptId,
          artifactHash: FIXTURE_HASH,
          stableIdempotencyKey: fixtures.artifact.stableIdempotencyKey,
          lifecycleState: 'dispatching',
          transportState: 'queued',
          clientCorrelation: fixtures.artifact.clientCorrelation,
          correlationBindingVersion:
            fixtures.artifact.correlationBindingVersion,
          retryDecision: 'not_applicable',
          attemptedAt: FIXTURE_NOW,
          stateVersion: 1,
        });
        const sent = sendAttemptSchema.safeParse({
          ...attempt,
          transportState: 'sent',
        });
        assert(!sent.success, 'forbidden sent state was persisted');
        let missingCorrelationRejected = false;
        try {
          applyTransportFact({
            actorTenantId: attempt.tenantId,
            attempt,
            nextState: 'provider_accepted',
          });
        } catch {
          missingCorrelationRejected = true;
        }
        assert(
          missingCorrelationRejected,
          'provider acceptance without correlation was allowed',
        );
        const unknown = applyTransportFact({
          actorTenantId: attempt.tenantId,
          attempt,
          nextState: 'acceptance_unknown',
        });
        let unsafeRetryRejected = false;
        try {
          assertOrdinaryRetryAllowed(unknown);
        } catch {
          unsafeRetryRejected = true;
        }
        assert(unsafeRetryRejected, 'unsafe retry was allowed');
      },
    ),
  );

  return {
    connectorId: connector.descriptor().connectorId,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

export async function assertCommunicationConnectorContract(
  connector: CommunicationConnector,
  fixtures: ConnectorContractFixtures,
): Promise<ConnectorContractReport> {
  const report = await runCommunicationConnectorContract(connector, fixtures);
  const failures = report.checks.filter((check) => !check.passed);
  if (failures.length > 0) {
    throw new Error(
      failures
        .map((failure) => `${failure.name}: ${failure.detail ?? 'failed'}`)
        .join('; '),
    );
  }
  return report;
}

export async function runWorkManagementConnectorContract(
  connector: WorkManagementConnector,
  fixtures: ConnectorContractFixtures,
): Promise<ConnectorContractReport> {
  const checks: ConnectorContractCheck[] = [];
  const capabilities = connector.descriptor().capabilities;
  const hasReadCapability =
    capabilities.readTasks ||
    capabilities.readProjects ||
    capabilities.readMilestones ||
    capabilities.readComments;
  const hasMutation =
    capabilities.createTask ||
    capabilities.updateTask ||
    capabilities.createComment;

  checks.push(
    await runCheck('work-management registry separation', () => {
      const registry = new ConnectorRuntimeRegistry();
      registry.registerWorkManagement(connector);
      assert(
        registry.workManagement(connector.descriptor().connectorId) ===
          connector,
        'work-management connector was not registered',
      );
      let communicationLookupRejected = false;
      try {
        registry.communication(connector.descriptor().connectorId);
      } catch {
        communicationLookupRejected = true;
      }
      assert(
        communicationLookupRejected,
        'work-management connector leaked into communication registry',
      );
    }),
  );
  checks.push(
    await runCheck(
      'work-management provider facts are capability-bound',
      async () => {
        assert(
          connector.connectorKind === 'work_management',
          'work-management connector claims a communication kind',
        );
        const health = connectionHealthSchema.parse(
          await connector.validateConnection(fixtures.accountRef),
        );
        assert(
          health.account.tenantId === fixtures.accountRef.tenantId &&
            health.account.accountId === fixtures.accountRef.accountId &&
            health.account.expectedStateVersion ===
              fixtures.accountRef.expectedStateVersion &&
            health.capabilitySnapshotHash ===
              fixtures.snapshot.capabilitySnapshotHash,
          'work-management health substituted account bindings',
        );
        if (hasReadCapability) {
          assert(
            connector.fetchObject !== undefined,
            'read-capable work management requires fetchObject',
          );
          const requested = {
            kind: 'task' as const,
            providerObjectId: 'task-a',
          };
          const fact = workObjectFactSchema.parse(
            await connector.fetchObject(fixtures.account, requested),
          );
          assert(
            fact.kind === requested.kind &&
              fact.providerObjectId === requested.providerObjectId,
            'work-management adapter substituted the requested object',
          );
        } else {
          assert(
            connector.fetchObject === undefined,
            'fetchObject exists without a read capability',
          );
        }
      },
    ),
  );
  checks.push(
    await runCheck('work-management webhook methods match capability', () => {
      assert(
        capabilities.webhooks
          ? connector.subscribe !== undefined &&
              connector.renewSubscription !== undefined
          : connector.subscribe === undefined &&
              connector.renewSubscription === undefined,
        'work-management webhook method parity failed',
      );
    }),
  );
  checks.push(
    await runCheck(
      'work-management subscription calls are fenced independently of effects',
      async () => {
        if (!capabilities.webhooks) {
          let unavailable = false;
          try {
            await invokeWorkManagementSubscriptionMutation(
              connector,
              fixtures.subscriptionRequest,
              FIXTURE_NOW,
            );
          } catch (error) {
            unavailable =
              error instanceof Error &&
              error.message === 'SUBSCRIPTION_CAPABILITY_NOT_AVAILABLE';
          }
          assert(
            unavailable,
            'disabled work subscription path did not fail closed',
          );
        }
        let calls = 0;
        const subscriptionConnector = {
          descriptor: () => ({
            ...connector.descriptor(),
            capabilities: {
              ...connector.descriptor().capabilities,
              webhooks: true,
            },
          }),
          subscribe: () => {
            calls += 1;
            return Promise.resolve({
              providerReference: 'work-subscription-a',
              providerResponseHash: FIXTURE_HASH,
              expiresAt: '2026-07-17T14:00:00.000Z',
              renewAfter: FIXTURE_LATER,
              observedAt: FIXTURE_NOW,
            });
          },
          renewSubscription: () => {
            calls += 1;
            return Promise.resolve({
              providerReference: 'work-subscription-a',
              providerResponseHash: FIXTURE_HASH,
              expiresAt: '2026-07-17T14:00:00.000Z',
              renewAfter: FIXTURE_LATER,
              observedAt: FIXTURE_NOW,
            });
          },
        } as unknown as WorkManagementConnector;
        let staleRejected = false;
        try {
          await invokeWorkManagementSubscriptionMutation(
            subscriptionConnector,
            {
              ...fixtures.subscriptionRequest,
              mutationClaim: {
                ...fixtures.subscriptionRequest.mutationClaim,
                expiresAt: FIXTURE_NOW,
              },
            },
            FIXTURE_NOW,
          );
        } catch (error) {
          staleRejected =
            error instanceof Error &&
            error.message === 'SUBSCRIPTION_MUTATION_FENCE_REJECTED';
        }
        assert(staleRejected, 'stale work subscription claim was accepted');
        assert(calls === 0, 'stale work subscription called the adapter');
        await invokeWorkManagementSubscriptionMutation(
          subscriptionConnector,
          fixtures.subscriptionRequest,
          FIXTURE_NOW,
        );
        assert(
          Number(calls) === 1,
          'valid work subscription did not call the adapter exactly once',
        );
      },
    ),
  );
  checks.push(
    await runCheck(
      'work-management effects use the guarded artifact path',
      async () => {
        const persistence = new InMemoryEffectPersistence();
        if (!hasMutation || !capabilities.externalEffect) {
          assert(
            connector.execute === undefined &&
              connector.reconcileEffect === undefined,
            'effect methods exist on a non-effectful work connector',
          );
          let rejected = false;
          try {
            await dispatchWorkManagementEffect(
              connector,
              persistence,
              authority(fixtures),
              fixtures.accountRef,
              fixtures.artifact,
              fixtures.snapshot,
            );
          } catch (error) {
            rejected =
              error instanceof Error &&
              error.message === 'WORK_MANAGEMENT_EFFECT_CAPABILITY_DISABLED';
          }
          assert(rejected, 'disabled work effect path did not fail closed');
          assert(
            persistence.attempts.size === 0,
            'disabled work effect path wrote an execution attempt',
          );
          return;
        }
        const result = await dispatchWorkManagementEffect(
          connector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(
          result.status === 'settled' &&
            result.attempt.transportState === 'provider_accepted' &&
            result.attempt.providerCorrelationDigest !== undefined,
          'work-management acceptance lacks durable correlation',
        );
        keyedDigestValueSchema.parse(result.attempt.providerCorrelationDigest);
        assert(
          !Object.hasOwn(result.attempt, 'providerCorrelation'),
          'raw work-provider correlation leaked into persisted attempt',
        );
        const duplicate = await dispatchWorkManagementEffect(
          connector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(duplicate.status === 'duplicate', 'work effect was duplicated');
      },
    ),
  );
  checks.push(
    await runCheck(
      'work-management unknown acceptance only reconciles',
      async () => {
        if (!hasMutation || !capabilities.externalEffect) {
          return;
        }
        const unknownConnector = {
          ...connector,
          execute: () =>
            Promise.resolve({
              outcome: 'acceptance_unknown' as const,
              reasonCode: 'work_effect_timeout',
              observedAt: FIXTURE_LATER,
            }),
        } as WorkManagementConnector;
        const persistence = new InMemoryEffectPersistence();
        const first = await dispatchWorkManagementEffect(
          unknownConnector,
          persistence,
          authority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(
          first.status === 'reconciliation_required',
          'unknown work effect was not frozen',
        );
        let retryRefused = false;
        try {
          await dispatchWorkManagementEffect(
            unknownConnector,
            persistence,
            authority(fixtures),
            fixtures.accountRef,
            fixtures.artifact,
            fixtures.snapshot,
          );
        } catch (error) {
          retryRefused = error instanceof UnknownAcceptanceRetryError;
        }
        assert(retryRefused, 'unknown work effect entered ordinary retry');
        const reconciled = await reconcileWorkManagementEffect(
          connector,
          persistence,
          reconciliationAuthority(fixtures),
          fixtures.accountRef,
          fixtures.artifact,
          fixtures.snapshot,
        );
        assert(
          reconciled.status === 'settled' &&
            reconciled.attempt.providerCorrelationDigest !== undefined,
          'work effect reconciliation did not bind provider correlation',
        );
      },
    ),
  );
  return {
    connectorId: connector.descriptor().connectorId,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

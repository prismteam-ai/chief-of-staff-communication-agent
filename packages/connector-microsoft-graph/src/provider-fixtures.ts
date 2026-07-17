import {
  effectExecutionArtifactSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import {
  connectorAccountSchema,
  connectorSnapshotSchema,
  pollRequestSchema,
  rawWebhookRequestSchema,
  subscriptionMutationRequestSchema,
  verifiedProviderEventSchema,
} from '@chief/contracts/connectors';
import {
  createConnectorContractFixtures,
  type ConnectorContractFixtures,
} from '@chief/connector-testkit';

import { microsoftGraphFixtureDescriptor } from './implementation-metadata.js';
import {
  GRAPH_FIXTURE_CLIENT_STATE,
  GRAPH_FIXTURE_NOW,
  graphNotificationBodyBase64,
} from './recorded-fixtures.js';
import {
  GRAPH_RECONCILIATION_STRATEGY,
  GRAPH_RECONCILIATION_STRATEGY_VERSION,
} from './send.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

export function createMicrosoftGraphContractFixtures(options?: {
  readonly selectedForEffectContract?: boolean;
}): ConnectorContractFixtures {
  const base = createConnectorContractFixtures();
  const snapshot = connectorSnapshotSchema.parse({
    connectorId: microsoftGraphFixtureDescriptor.connectorId,
    descriptorVersion: microsoftGraphFixtureDescriptor.descriptorVersion,
    accountId: base.accountRef.accountId,
    capabilitySnapshotHash: HASH_A,
    runtimeMode: options?.selectedForEffectContract
      ? 'virtual_test'
      : 'disabled',
    selectionState: options?.selectedForEffectContract
      ? 'selected'
      : 'unselected_candidate',
  });
  const account = connectorAccountSchema.parse({
    ...base.account,
    provider: microsoftGraphFixtureDescriptor.provider,
    channel: microsoftGraphFixtureDescriptor.channel,
    displayLabel: 'Microsoft personal account fixture',
    snapshot,
    status: 'disabled',
    health: 'healthy',
  });
  const artifact = effectExecutionArtifactSchema.parse({
    ...base.artifact,
    connectorSnapshot: snapshot,
    clientCorrelation: {
      kind: 'provider_draft_id',
      value: 'immutable-draft-a',
    },
    reconciliationStrategy: GRAPH_RECONCILIATION_STRATEGY,
    reconciliationStrategyVersion: GRAPH_RECONCILIATION_STRATEGY_VERSION,
  });
  const reconcileRequest = reconcileSendRequestSchema.parse({
    ...base.reconcileRequest,
    artifact,
    strategy: GRAPH_RECONCILIATION_STRATEGY,
    strategyVersion: GRAPH_RECONCILIATION_STRATEGY_VERSION,
  });
  const verifiedEvent = verifiedProviderEventSchema.parse({
    ...base.verifiedEvent,
    providerEventId: 'graph-event-a',
    rawEventRef: 's3://private-fixture/graph-event-a',
    rawPayloadDigest: HASH_C,
    verificationMethod: 'graph-client-state-v1',
    connectorSnapshot: snapshot,
  });
  const webhookRequest = rawWebhookRequestSchema.parse({
    method: 'POST',
    providerVisibleUrl: 'https://example.invalid/webhooks/microsoft-graph',
    headers: { 'content-type': 'application/json' },
    rawBodyBase64: graphNotificationBodyBase64(),
    receivedAt: GRAPH_FIXTURE_NOW,
  });
  const pollRequest = pollRequestSchema.parse({
    ...base.pollRequest,
    adapterVersion: microsoftGraphFixtureDescriptor.descriptorVersion,
    checkpoint: {
      ...base.pollRequest.checkpoint,
      kind: 'delta',
      encryptedCursor: 'sealed:graph-delta-root',
      adapterVersion: microsoftGraphFixtureDescriptor.descriptorVersion,
    },
  });
  const subscriptionRequest = subscriptionMutationRequestSchema.parse({
    ...base.subscriptionRequest,
    hostedCallbackReleaseHash: HASH_A,
    hostedCallbackDeploymentHash: HASH_B,
  });
  return {
    descriptor: microsoftGraphFixtureDescriptor,
    snapshot,
    account,
    accountRef: base.accountRef,
    artifact,
    reconcileRequest,
    verifiedEvent,
    webhookRequest,
    pollRequest,
    subscriptionRequest,
    feedbackContext: {
      ...base.feedbackContext,
      connectorSnapshot: snapshot,
    },
  };
}

export { GRAPH_FIXTURE_CLIENT_STATE };

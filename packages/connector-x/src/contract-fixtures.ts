import {
  effectExecutionArtifactSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import {
  connectorAccountSchema,
  connectorDescriptorSchema,
  connectorSnapshotSchema,
  pollRequestSchema,
  verifiedProviderEventSchema,
} from '@chief/contracts/connectors';
import type {
  ConnectorDescriptor,
  ConnectorRuntimeMode,
  ConnectorSelectionState,
} from '@chief/contracts/connectors';
import {
  createConnectorContractFixtures,
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_HASH_C,
} from '@chief/connector-testkit';
import type { ConnectorContractFixtures } from '@chief/connector-testkit';

function createXFixtures(input: {
  readonly descriptor: ConnectorDescriptor;
  readonly runtimeMode: ConnectorRuntimeMode;
  readonly selectionState: ConnectorSelectionState;
}): ConnectorContractFixtures {
  const base = createConnectorContractFixtures();
  // The shared runner uses fixtures.descriptor for its own deliberately fully
  // capable deterministic control. The adapter under test still returns the
  // truthful X descriptor and is checked independently for method parity.
  const runnerControlDescriptor = connectorDescriptorSchema.parse({
    ...base.descriptor,
    connectorId: input.descriptor.connectorId,
    descriptorVersion: input.descriptor.descriptorVersion,
    provider: input.descriptor.provider,
    channel: input.descriptor.channel,
  });
  const accountId =
    input.descriptor.connectorId === 'x_legacy_dm'
      ? 'account-x-legacy'
      : 'account-xchat';
  const snapshot = connectorSnapshotSchema.parse({
    connectorId: input.descriptor.connectorId,
    descriptorVersion: input.descriptor.descriptorVersion,
    accountId,
    capabilitySnapshotHash:
      input.descriptor.connectorId === 'x_legacy_dm'
        ? FIXTURE_HASH
        : FIXTURE_HASH_B,
    runtimeMode: input.runtimeMode,
    selectionState: input.selectionState,
  });
  const accountRef = {
    tenantId: base.accountRef.tenantId,
    accountId: snapshot.accountId,
    expectedStateVersion: base.accountRef.expectedStateVersion,
  };
  const account = connectorAccountSchema.parse({
    ...base.account,
    accountId,
    provider: input.descriptor.provider,
    channel: input.descriptor.channel,
    displayLabel: input.descriptor.connectorId,
    snapshot,
  });
  const artifact = effectExecutionArtifactSchema.parse({
    ...base.artifact,
    account: accountRef,
    connectorSnapshot: snapshot,
    clientCorrelation: {
      kind: 'client_reference',
      value: 'x-client-operation-a',
    },
    reconciliationStrategy: 'x_legacy_dm_lookup',
  });
  const reconcileRequest = reconcileSendRequestSchema.parse({
    ...base.reconcileRequest,
    artifact,
    priorAttemptId: artifact.attemptId,
    strategy: artifact.reconciliationStrategy,
  });
  const verifiedEvent = verifiedProviderEventSchema.parse({
    ...base.verifiedEvent,
    accountId,
    rawPayloadDigest: FIXTURE_HASH_C,
    connectorSnapshot: snapshot,
  });
  const pollRequest = pollRequestSchema.parse({
    ...base.pollRequest,
    account: accountRef,
    checkpoint: {
      ...base.pollRequest.checkpoint,
      accountId,
      encryptedCursor:
        input.descriptor.connectorId === 'x_legacy_dm'
          ? 'xlegacy:fixture-page-1'
          : 'xchat:blocked',
      adapterVersion: input.descriptor.descriptorVersion,
    },
    adapterVersion: input.descriptor.descriptorVersion,
  });
  return {
    ...base,
    descriptor: runnerControlDescriptor,
    snapshot,
    account,
    accountRef,
    artifact,
    reconcileRequest,
    verifiedEvent,
    pollRequest,
    feedbackContext: {
      ...base.feedbackContext,
      account: accountRef,
      connectorSnapshot: snapshot,
    },
  };
}

export function createXProviderFixtures(input: {
  readonly descriptor: ConnectorDescriptor;
  readonly runtimeMode: Exclude<ConnectorRuntimeMode, 'live'>;
  readonly selectionState: ConnectorSelectionState;
}): ConnectorContractFixtures {
  return createXFixtures(input);
}

/**
 * The frozen connector-testkit runs its own effect-capable deterministic
 * control with the same fixture object. Only that generic internal control
 * requires live/selected state. Provider fixtures and adapter defaults never
 * use this helper.
 */
export function createXRunnerControlFixtures(
  descriptor: ConnectorDescriptor,
): ConnectorContractFixtures {
  return createXFixtures({
    descriptor,
    runtimeMode: 'live',
    selectionState: 'selected',
  });
}

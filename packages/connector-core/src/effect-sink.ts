import {
  effectExecutionArtifactSchema,
  providerSendResultSchema,
  reconcileSendRequestSchema,
} from '@chief/contracts/approval';
import type {
  EffectExecutionArtifact,
  ProviderSendResult,
  ReconcileSendRequest,
  TransportState,
} from '@chief/contracts/approval';
import type {
  ConnectorAccountRef,
  ConnectorSnapshot,
} from '@chief/contracts/connectors';
import type { KeyedDigestValue } from '@chief/contracts/ids';

import type { CommunicationConnector } from './communication-connector.js';
import type { WorkManagementConnector } from './work-management-connector.js';

export interface PersistedEffectAttempt {
  readonly operationId: EffectExecutionArtifact['operationId'];
  readonly attemptId: EffectExecutionArtifact['attemptId'];
  readonly lifecycle:
    'prepared' | 'dispatching' | 'settled' | 'reconciliation_required';
  readonly transportState: TransportState;
  readonly clientCorrelation: EffectExecutionArtifact['clientCorrelation'];
  readonly correlationBindingVersion: EffectExecutionArtifact['correlationBindingVersion'];
  readonly providerCorrelationDigest?: KeyedDigestValue;
}

type ConditionalAttemptResult =
  | { readonly status: 'claimed'; readonly attempt: PersistedEffectAttempt }
  | { readonly status: 'contended'; readonly attempt: PersistedEffectAttempt };

export interface EffectExecutionPersistence {
  prepareConditionally(
    artifact: EffectExecutionArtifact,
  ): Promise<
    | { readonly status: 'created'; readonly attempt: PersistedEffectAttempt }
    | { readonly status: 'existing'; readonly attempt: PersistedEffectAttempt }
  >;
  claimDispatchConditionally(
    artifact: EffectExecutionArtifact,
  ): Promise<ConditionalAttemptResult>;
  releaseUncalledClaimConditionally(
    artifact: EffectExecutionArtifact,
  ): Promise<PersistedEffectAttempt>;
  claimReconciliationConditionally(
    artifact: EffectExecutionArtifact,
  ): Promise<ConditionalAttemptResult>;
  releaseReconciliationClaimConditionally(
    artifact: EffectExecutionArtifact,
  ): Promise<PersistedEffectAttempt>;
  settleRejected(
    artifact: EffectExecutionArtifact,
    result: Extract<ProviderSendResult, { readonly outcome: 'rejected' }>,
  ): Promise<PersistedEffectAttempt>;
  settleAcceptedAndBindCorrelation(
    artifact: EffectExecutionArtifact,
    result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
  ): Promise<PersistedEffectAttempt>;
  freezeAcceptanceUnknown(
    artifact: EffectExecutionArtifact,
    result?: Extract<
      ProviderSendResult,
      { readonly outcome: 'acceptance_unknown' }
    >,
  ): Promise<PersistedEffectAttempt>;
}

export interface EffectArtifactAuthority {
  assertCurrent(artifact: EffectExecutionArtifact): Promise<void>;
}

export interface EffectReconciliationAuthority {
  assertReadableForReconciliation(
    account: ConnectorAccountRef,
    artifact: EffectExecutionArtifact,
  ): Promise<void>;
}

export type EffectDispatchResult =
  | {
      readonly status: 'duplicate' | 'contended';
      readonly attempt: PersistedEffectAttempt;
    }
  | {
      readonly status: 'settled';
      readonly providerResult: ProviderSendResult;
      readonly attempt: PersistedEffectAttempt;
    }
  | {
      readonly status: 'reconciliation_required';
      readonly providerResult?: ProviderSendResult;
      readonly attempt: PersistedEffectAttempt;
    };

export class UnknownAcceptanceRetryError extends Error {
  public constructor() {
    super('ACCEPTANCE_UNKNOWN_REQUIRES_RECONCILIATION');
    this.name = 'UnknownAcceptanceRetryError';
  }
}

interface EffectDescriptor {
  readonly connectorId: string;
  readonly descriptorVersion: string;
  readonly supportedRuntimeModes: readonly ConnectorSnapshot['runtimeMode'][];
  readonly capabilities: { readonly externalEffect: boolean };
}

function assertDispatchSnapshot(
  descriptor: EffectDescriptor,
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
  currentSnapshot: ConnectorSnapshot,
): void {
  if (
    artifact.tenantId !== account.tenantId ||
    artifact.account.tenantId !== account.tenantId ||
    artifact.account.accountId !== account.accountId ||
    artifact.account.expectedStateVersion !== account.expectedStateVersion ||
    artifact.connectorSnapshot.accountId !== account.accountId ||
    currentSnapshot.accountId !== account.accountId ||
    artifact.connectorSnapshot.connectorId !== descriptor.connectorId ||
    artifact.connectorSnapshot.descriptorVersion !==
      descriptor.descriptorVersion ||
    artifact.connectorSnapshot.capabilitySnapshotHash !==
      currentSnapshot.capabilitySnapshotHash ||
    artifact.connectorSnapshot.runtimeMode !== currentSnapshot.runtimeMode ||
    artifact.connectorSnapshot.selectionState !== currentSnapshot.selectionState
  ) {
    throw new Error('EFFECT_ARTIFACT_SNAPSHOT_MISMATCH');
  }
  if (
    !descriptor.capabilities.externalEffect ||
    !descriptor.supportedRuntimeModes.includes(currentSnapshot.runtimeMode) ||
    currentSnapshot.selectionState !== 'selected' ||
    currentSnapshot.runtimeMode === 'fixture' ||
    currentSnapshot.runtimeMode === 'manual' ||
    currentSnapshot.runtimeMode === 'blocked_external_access' ||
    currentSnapshot.runtimeMode === 'disabled'
  ) {
    throw new Error('EXTERNAL_EFFECT_CAPABILITY_DISABLED');
  }
}

function existingAttemptResult(
  attempt: PersistedEffectAttempt,
): EffectDispatchResult {
  if (
    attempt.lifecycle === 'reconciliation_required' ||
    attempt.transportState === 'acceptance_unknown'
  ) {
    throw new UnknownAcceptanceRetryError();
  }
  if (attempt.lifecycle === 'dispatching') {
    return { status: 'contended', attempt };
  }
  return { status: 'duplicate', attempt };
}

type EffectInvocation = (
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
) => Promise<ProviderSendResult>;

async function dispatchGuardedEffect(
  descriptor: EffectDescriptor,
  invoke: EffectInvocation,
  persistence: EffectExecutionPersistence,
  authority: EffectArtifactAuthority,
  account: ConnectorAccountRef,
  artifactInput: EffectExecutionArtifact,
  currentSnapshot: ConnectorSnapshot,
): Promise<EffectDispatchResult> {
  const artifact = effectExecutionArtifactSchema.parse(artifactInput);
  assertDispatchSnapshot(descriptor, account, artifact, currentSnapshot);

  const prepared = await persistence.prepareConditionally(artifact);
  if (
    prepared.status === 'existing' &&
    prepared.attempt.lifecycle !== 'prepared'
  ) {
    return existingAttemptResult(prepared.attempt);
  }
  const claim = await persistence.claimDispatchConditionally(artifact);
  if (claim.status === 'contended') {
    return { status: 'contended', attempt: claim.attempt };
  }

  try {
    await authority.assertCurrent(artifact);
  } catch (error) {
    await persistence.releaseUncalledClaimConditionally(artifact);
    throw error;
  }

  let providerResult: ProviderSendResult;
  try {
    providerResult = providerSendResultSchema.parse(
      await invoke(account, artifact),
    );
  } catch {
    const attempt = await persistence.freezeAcceptanceUnknown(artifact);
    return { status: 'reconciliation_required', attempt };
  }

  return persistProviderResult(persistence, artifact, providerResult);
}

async function persistProviderResult(
  persistence: EffectExecutionPersistence,
  artifact: EffectExecutionArtifact,
  providerResult: ProviderSendResult,
): Promise<EffectDispatchResult> {
  if (providerResult.outcome === 'acceptance_unknown') {
    const attempt = await persistence.freezeAcceptanceUnknown(
      artifact,
      providerResult,
    );
    return { status: 'reconciliation_required', providerResult, attempt };
  }
  if (providerResult.outcome === 'rejected') {
    const attempt = await persistence.settleRejected(artifact, providerResult);
    return { status: 'settled', providerResult, attempt };
  }
  try {
    const attempt = await persistence.settleAcceptedAndBindCorrelation(
      artifact,
      providerResult,
    );
    return { status: 'settled', providerResult, attempt };
  } catch {
    const unknown: Extract<
      ProviderSendResult,
      { readonly outcome: 'acceptance_unknown' }
    > = {
      outcome: 'acceptance_unknown',
      providerResponseHash: providerResult.providerResponseHash,
      reasonCode: 'correlation_persistence_failed',
      observedAt: providerResult.observedAt,
    };
    const attempt = await persistence.freezeAcceptanceUnknown(
      artifact,
      unknown,
    );
    return {
      status: 'reconciliation_required',
      providerResult: unknown,
      attempt,
    };
  }
}

async function reconcileGuardedEffect(
  descriptor: EffectDescriptor,
  reconcile: EffectInvocation,
  persistence: EffectExecutionPersistence,
  authority: EffectReconciliationAuthority,
  account: ConnectorAccountRef,
  artifactInput: EffectExecutionArtifact,
  currentSnapshot: ConnectorSnapshot,
): Promise<EffectDispatchResult> {
  const artifact = effectExecutionArtifactSchema.parse(artifactInput);
  assertDispatchSnapshot(descriptor, account, artifact, currentSnapshot);
  const claim = await persistence.claimReconciliationConditionally(artifact);
  if (claim.status === 'contended') {
    return { status: 'contended', attempt: claim.attempt };
  }
  let providerResult: ProviderSendResult;
  try {
    await authority.assertReadableForReconciliation(account, artifact);
    providerResult = providerSendResultSchema.parse(
      await reconcile(account, artifact),
    );
  } catch (error) {
    await persistence.releaseReconciliationClaimConditionally(artifact);
    throw error;
  }
  return persistProviderResult(persistence, artifact, providerResult);
}

export function dispatchCommunicationEffect(
  connector: CommunicationConnector,
  persistence: EffectExecutionPersistence,
  authority: EffectArtifactAuthority,
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
  currentSnapshot: ConnectorSnapshot,
): Promise<EffectDispatchResult> {
  if (
    !connector.descriptor().capabilities.send ||
    connector.send === undefined
  ) {
    throw new Error('CONNECTOR_SEND_CAPABILITY_DISABLED');
  }
  return dispatchGuardedEffect(
    connector.descriptor(),
    connector.send.bind(connector),
    persistence,
    authority,
    account,
    artifact,
    currentSnapshot,
  );
}

export async function reconcileCommunicationEffect(
  connector: CommunicationConnector,
  persistence: EffectExecutionPersistence,
  authority: EffectReconciliationAuthority,
  account: ConnectorAccountRef,
  requestInput: ReconcileSendRequest,
  currentSnapshot: ConnectorSnapshot,
): Promise<EffectDispatchResult> {
  if (
    !connector.descriptor().capabilities.send ||
    connector.reconcileSend === undefined
  ) {
    throw new Error('COMMUNICATION_RECONCILIATION_UNAVAILABLE');
  }
  const request = reconcileSendRequestSchema.parse(requestInput);
  const artifact = request.artifact;
  if (
    request.priorAttemptId !== artifact.attemptId ||
    request.strategy !== artifact.reconciliationStrategy ||
    request.strategyVersion !== artifact.reconciliationStrategyVersion
  ) {
    throw new Error('RECONCILIATION_REQUEST_BINDING_MISMATCH');
  }
  assertDispatchSnapshot(
    connector.descriptor(),
    account,
    artifact,
    currentSnapshot,
  );
  const claim = await persistence.claimReconciliationConditionally(artifact);
  if (claim.status === 'contended') {
    return { status: 'contended', attempt: claim.attempt };
  }
  if (
    claim.attempt.operationId !== artifact.operationId ||
    claim.attempt.attemptId !== request.priorAttemptId ||
    claim.attempt.lifecycle !== 'reconciliation_required' ||
    claim.attempt.transportState !== 'acceptance_unknown'
  ) {
    await persistence.releaseReconciliationClaimConditionally(artifact);
    throw new Error('RECONCILIATION_ATTEMPT_BINDING_MISMATCH');
  }

  let providerResult: ProviderSendResult;
  try {
    await authority.assertReadableForReconciliation(account, artifact);
    providerResult = providerSendResultSchema.parse(
      await connector.reconcileSend(account, request),
    );
  } catch (error) {
    await persistence.releaseReconciliationClaimConditionally(artifact);
    throw error;
  }
  return persistProviderResult(persistence, artifact, providerResult);
}

export function dispatchWorkManagementEffect(
  connector: WorkManagementConnector,
  persistence: EffectExecutionPersistence,
  authority: EffectArtifactAuthority,
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
  currentSnapshot: ConnectorSnapshot,
): Promise<EffectDispatchResult> {
  const capabilities = connector.descriptor().capabilities;
  if (
    connector.execute === undefined ||
    (!capabilities.createTask &&
      !capabilities.updateTask &&
      !capabilities.createComment)
  ) {
    throw new Error('WORK_MANAGEMENT_EFFECT_CAPABILITY_DISABLED');
  }
  return dispatchGuardedEffect(
    connector.descriptor(),
    connector.execute.bind(connector),
    persistence,
    authority,
    account,
    artifact,
    currentSnapshot,
  );
}

export function reconcileWorkManagementEffect(
  connector: WorkManagementConnector,
  persistence: EffectExecutionPersistence,
  authority: EffectReconciliationAuthority,
  account: ConnectorAccountRef,
  artifact: EffectExecutionArtifact,
  currentSnapshot: ConnectorSnapshot,
): Promise<EffectDispatchResult> {
  const capabilities = connector.descriptor().capabilities;
  if (
    connector.reconcileEffect === undefined ||
    (!capabilities.createTask &&
      !capabilities.updateTask &&
      !capabilities.createComment)
  ) {
    throw new Error('WORK_MANAGEMENT_RECONCILIATION_UNAVAILABLE');
  }
  return reconcileGuardedEffect(
    connector.descriptor(),
    connector.reconcileEffect.bind(connector),
    persistence,
    authority,
    account,
    artifact,
    currentSnapshot,
  );
}

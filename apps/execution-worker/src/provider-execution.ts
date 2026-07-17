import type {
  ApprovalExecutionPersistence,
  ExecutionSink,
  OperationClaim,
} from '@chief/approval-outbox/execution-service';
import type {
  EffectExecutionArtifact,
  ProviderSendResult,
} from '@chief/contracts/approval';
import { providerSendResultSchema } from '@chief/contracts/approval';
import type { CommunicationConnector } from '@chief/connector-core';
import type { WorkManagementConnector } from '@chief/connector-core';

import type { ControlledEffectEnvelope } from './runtime-policy.js';

export type PreDispatchOutcome =
  | Readonly<{
      disposition: 'denied';
      reasonCode: string;
      observedAt: string;
    }>
  | Readonly<{
      disposition: 'retryable';
      reasonCode: string;
      observedAt: string;
    }>;

export class PreDispatchDeniedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreDispatchDeniedError';
  }
}

export class PreDispatchRetryableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreDispatchRetryableError';
  }
}

export interface ClaimHeartbeatPersistence extends ApprovalExecutionPersistence {
  heartbeatClaim(input: {
    readonly claim: OperationClaim;
    readonly observedAt: string;
    readonly leaseDurationMs: number;
  }): Promise<'renewed' | 'lost'>;
  assertProviderBoundaryCurrent(input: {
    readonly claim: OperationClaim;
    readonly artifact: EffectExecutionArtifact;
    readonly envelope: ControlledEffectEnvelope;
    readonly observedAt: string;
  }): Promise<void>;
  settlePreDispatchDenied(input: {
    readonly claim: OperationClaim;
    readonly artifact: EffectExecutionArtifact;
    readonly outcome: PreDispatchOutcome & { readonly disposition: 'denied' };
  }): Promise<void>;
  settlePreDispatchRetryable(input: {
    readonly claim: OperationClaim;
    readonly artifact: EffectExecutionArtifact;
    readonly outcome: PreDispatchOutcome & {
      readonly disposition: 'retryable';
    };
  }): Promise<void>;
  settleAcceptedWorkManagementEffect?(input: {
    readonly claim: OperationClaim;
    readonly artifact: EffectExecutionArtifact;
    readonly result: Extract<
      ProviderSendResult,
      { readonly outcome: 'accepted' }
    >;
  }): Promise<void>;
}

export interface EffectConnectorSelector {
  communication(connectorId: string): CommunicationConnector;
  workManagement(connectorId: string): WorkManagementConnector;
}

export interface ProviderExecutionSinkInput {
  readonly persistence: ClaimHeartbeatPersistence;
  readonly claim: () => OperationClaim | undefined;
  readonly envelope: () => ControlledEffectEnvelope | undefined;
  readonly connectors: EffectConnectorSelector;
  readonly now: () => string;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly recordPreDispatchOutcome?: (outcome: PreDispatchOutcome) => void;
}

function sameDescriptor(
  descriptor: {
    readonly connectorId: string;
    readonly descriptorVersion: string;
    readonly supportedRuntimeModes: readonly string[];
    readonly capabilities: { readonly externalEffect: boolean };
  },
  artifact: EffectExecutionArtifact,
): boolean {
  return (
    descriptor.connectorId === artifact.connectorSnapshot.connectorId &&
    descriptor.descriptorVersion ===
      artifact.connectorSnapshot.descriptorVersion &&
    descriptor.supportedRuntimeModes.includes(
      artifact.connectorSnapshot.runtimeMode,
    ) &&
    descriptor.capabilities.externalEffect
  );
}

export function assertSelectedEffectConnector(input: {
  readonly connectors: EffectConnectorSelector;
  readonly envelope: ControlledEffectEnvelope;
  readonly artifact: EffectExecutionArtifact;
}): void {
  if (input.envelope.kind === 'communication') {
    if (input.envelope.operation !== 'send_message') {
      throw new PreDispatchDeniedError(
        'COMMUNICATION_OPERATION_CAPABILITY_DISABLED',
      );
    }
    const connector = input.connectors.communication(
      input.envelope.connectorId,
    );
    const descriptor = connector.descriptor();
    if (
      connector.send === undefined ||
      !descriptor.capabilities.send ||
      !sameDescriptor(descriptor, input.artifact)
    ) {
      throw new PreDispatchDeniedError(
        'COMMUNICATION_EFFECT_CAPABILITY_DISABLED',
      );
    }
    return;
  }
  const connector = input.connectors.workManagement(input.envelope.connectorId);
  const descriptor = connector.descriptor();
  const capabilities = descriptor.capabilities;
  const exactOperationEnabled =
    (input.envelope.operation === 'create_task' && capabilities.createTask) ||
    (input.envelope.operation === 'update_task' && capabilities.updateTask) ||
    (input.envelope.operation === 'create_comment' &&
      capabilities.createComment);
  if (
    connector.execute === undefined ||
    !exactOperationEnabled ||
    !sameDescriptor(descriptor, input.artifact)
  ) {
    throw new PreDispatchDeniedError(
      'WORK_MANAGEMENT_EFFECT_CAPABILITY_DISABLED',
    );
  }
}

function toPreDispatchOutcome(
  error: unknown,
  observedAt: string,
): PreDispatchOutcome {
  const isSafeReasonCode = (value: string): boolean =>
    /^[A-Za-z0-9_]{1,96}$/u.test(value);
  if (error instanceof PreDispatchDeniedError) {
    return {
      disposition: 'denied',
      reasonCode: isSafeReasonCode(error.message)
        ? error.message
        : 'PRE_DISPATCH_DENIED',
      observedAt,
    };
  }
  if (error instanceof PreDispatchRetryableError) {
    return {
      disposition: 'retryable',
      reasonCode: isSafeReasonCode(error.message)
        ? error.message
        : 'PRE_DISPATCH_INFRASTRUCTURE_FAILURE',
      observedAt,
    };
  }
  return {
    disposition: 'retryable',
    reasonCode: 'PRE_DISPATCH_INFRASTRUCTURE_FAILURE',
    observedAt,
  };
}

class ClaimHeartbeat {
  #timer: ReturnType<typeof setInterval> | undefined;
  #lost = false;
  #pending: Promise<void> = Promise.resolve();

  public constructor(
    private readonly persistence: ClaimHeartbeatPersistence,
    private readonly claim: OperationClaim,
    private readonly now: () => string,
    private readonly intervalMs: number,
    private readonly leaseDurationMs: number,
  ) {}

  public async start(): Promise<void> {
    await this.renew();
    this.#timer = setInterval(() => {
      this.#pending = this.#pending
        .then(() => this.renew())
        .catch(() => {
          this.#lost = true;
        });
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  public async verify(): Promise<boolean> {
    await this.#pending;
    if (this.#lost) return false;
    await this.renew();
    return !this.#lost;
  }

  public async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#pending;
  }

  private async renew(): Promise<void> {
    const result = await this.persistence.heartbeatClaim({
      claim: this.claim,
      observedAt: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    });
    if (result === 'lost') {
      this.#lost = true;
      throw new Error('OUTBOX_CLAIM_LOST');
    }
  }
}

/**
 * Frozen Wave 1 names the external sink mode `provider_fake`; this adapter is
 * the real provider path and retains that literal solely for interface parity.
 */
export class GuardedProviderExecutionSink implements ExecutionSink {
  public readonly mode = 'provider_fake' as const;

  public constructor(private readonly input: ProviderExecutionSinkInput) {}

  public async dispatch(
    artifact: EffectExecutionArtifact,
  ): Promise<ProviderSendResult> {
    const claim = this.input.claim();
    if (claim === undefined) throw new Error('OUTBOX_CLAIM_NOT_CAPTURED');
    const heartbeat = new ClaimHeartbeat(
      this.input.persistence,
      claim,
      this.input.now,
      this.input.heartbeatIntervalMs,
      this.input.leaseDurationMs,
    );
    let adapterBoundaryCrossed = false;

    try {
      await heartbeat.start();
      const envelope = this.input.envelope();
      if (envelope === undefined)
        throw new PreDispatchRetryableError('EFFECT_PREFLIGHT_NOT_CAPTURED');
      if (!(await heartbeat.verify())) {
        throw new PreDispatchRetryableError(
          'outbox_claim_lost_before_dispatch',
        );
      }
      await this.input.persistence.assertProviderBoundaryCurrent({
        claim,
        artifact,
        envelope,
        observedAt: this.input.now(),
      });

      const result = await this.dispatchSelected(envelope, artifact, () => {
        adapterBoundaryCrossed = true;
      });
      if (!(await heartbeat.verify())) {
        return this.unknown('outbox_claim_lost_after_dispatch');
      }
      return result;
    } catch (error) {
      if (!adapterBoundaryCrossed) {
        this.input.recordPreDispatchOutcome?.(
          toPreDispatchOutcome(error, this.input.now()),
        );
      }
      throw error;
    } finally {
      await heartbeat.stop();
    }
  }

  private async dispatchSelected(
    envelope: ControlledEffectEnvelope,
    artifact: EffectExecutionArtifact,
    markAdapterBoundaryCrossed: () => void,
  ): Promise<ProviderSendResult> {
    assertSelectedEffectConnector({
      connectors: this.input.connectors,
      envelope,
      artifact,
    });
    if (envelope.kind === 'communication') {
      const connector = this.input.connectors.communication(
        envelope.connectorId,
      );
      if (connector.send === undefined)
        throw new PreDispatchDeniedError(
          'COMMUNICATION_EFFECT_CAPABILITY_DISABLED',
        );
      markAdapterBoundaryCrossed();
      return providerSendResultSchema.parse(
        await connector.send(artifact.account, artifact),
      );
    }

    const connector = this.input.connectors.workManagement(
      envelope.connectorId,
    );
    if (connector.execute === undefined) {
      throw new PreDispatchDeniedError(
        'WORK_MANAGEMENT_EFFECT_CAPABILITY_DISABLED',
      );
    }
    markAdapterBoundaryCrossed();
    return providerSendResultSchema.parse(
      await connector.execute(artifact.account, artifact),
    );
  }

  private unknown(reasonCode: string): ProviderSendResult {
    return {
      outcome: 'acceptance_unknown',
      reasonCode,
      observedAt: this.input.now(),
    };
  }
}

export class ClaimCapturingPersistence implements ApprovalExecutionPersistence {
  public capturedClaim: OperationClaim | undefined;
  public capturedArtifact: EffectExecutionArtifact | undefined;

  public constructor(
    private readonly delegate: ClaimHeartbeatPersistence,
    private readonly beforeDispatchAttempt?: (
      claim: OperationClaim,
      artifact: EffectExecutionArtifact,
    ) => Promise<void>,
    private readonly settleAcceptedOverride?: (
      claim: OperationClaim,
      artifact: EffectExecutionArtifact,
      result: Extract<ProviderSendResult, { readonly outcome: 'accepted' }>,
    ) => Promise<void>,
    private readonly preDispatchOutcome?: () => PreDispatchOutcome | undefined,
  ) {}

  public async claimOperation(
    input: Parameters<ApprovalExecutionPersistence['claimOperation']>[0],
  ) {
    const result = await this.delegate.claimOperation(input);
    if (result.status === 'claimed') this.capturedClaim = result.claim;
    return result;
  }

  public loadAuthoritativeState(
    operationId: Parameters<
      ApprovalExecutionPersistence['loadAuthoritativeState']
    >[0],
  ) {
    return this.delegate.loadAuthoritativeState(operationId);
  }

  public releaseUncalledClaim(
    claim: Parameters<ApprovalExecutionPersistence['releaseUncalledClaim']>[0],
  ) {
    return this.delegate.releaseUncalledClaim(claim);
  }

  public async persistDispatchAttempt(
    claim: Parameters<
      ApprovalExecutionPersistence['persistDispatchAttempt']
    >[0],
    artifact: Parameters<
      ApprovalExecutionPersistence['persistDispatchAttempt']
    >[1],
  ) {
    try {
      await this.beforeDispatchAttempt?.(claim, artifact);
    } catch (error) {
      await this.delegate.releaseUncalledClaim(claim);
      throw error;
    }
    this.capturedArtifact = artifact;
    return this.delegate.persistDispatchAttempt(claim, artifact);
  }

  public settleEffectDisabled(
    claim: Parameters<ApprovalExecutionPersistence['settleEffectDisabled']>[0],
    receipt: Parameters<
      ApprovalExecutionPersistence['settleEffectDisabled']
    >[1],
  ) {
    return this.delegate.settleEffectDisabled(claim, receipt);
  }

  public settleRejected(
    claim: Parameters<ApprovalExecutionPersistence['settleRejected']>[0],
    result: Parameters<ApprovalExecutionPersistence['settleRejected']>[1],
  ) {
    return this.delegate.settleRejected(claim, result);
  }

  public settleAcceptedAndCorrelation(
    claim: Parameters<
      ApprovalExecutionPersistence['settleAcceptedAndCorrelation']
    >[0],
    result: Parameters<
      ApprovalExecutionPersistence['settleAcceptedAndCorrelation']
    >[1],
  ) {
    if (this.settleAcceptedOverride !== undefined) {
      if (this.capturedArtifact === undefined) {
        return Promise.reject(new Error('EFFECT_ARTIFACT_NOT_CAPTURED'));
      }
      return this.settleAcceptedOverride(claim, this.capturedArtifact, result);
    }
    return this.delegate.settleAcceptedAndCorrelation(claim, result);
  }

  public freezeAcceptanceUnknown(
    claim: Parameters<
      ApprovalExecutionPersistence['freezeAcceptanceUnknown']
    >[0],
    reasonCode: Parameters<
      ApprovalExecutionPersistence['freezeAcceptanceUnknown']
    >[1],
    result?: Parameters<
      ApprovalExecutionPersistence['freezeAcceptanceUnknown']
    >[2],
  ) {
    const preDispatch = this.preDispatchOutcome?.();
    if (preDispatch !== undefined) {
      if (this.capturedArtifact === undefined) {
        return Promise.reject(new Error('EFFECT_ARTIFACT_NOT_CAPTURED'));
      }
      if (preDispatch.disposition === 'denied') {
        return this.delegate.settlePreDispatchDenied({
          claim,
          artifact: this.capturedArtifact,
          outcome: preDispatch,
        });
      }
      return this.delegate.settlePreDispatchRetryable({
        claim,
        artifact: this.capturedArtifact,
        outcome: preDispatch,
      });
    }
    return this.delegate.freezeAcceptanceUnknown(claim, reasonCode, result);
  }
}

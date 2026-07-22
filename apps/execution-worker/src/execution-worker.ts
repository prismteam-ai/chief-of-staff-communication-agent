import {
  EffectDisabledSink,
  executeApprovedOperation,
  type ExecuteOperationResult,
} from '@chief/approval-outbox/execution-service';

import type { ExecutionWorkerEvent } from './handler.js';
import {
  ClaimCapturingPersistence,
  GuardedProviderExecutionSink,
  assertSelectedEffectConnector,
  type ClaimHeartbeatPersistence,
  type EffectConnectorSelector,
  type PreDispatchOutcome,
} from './provider-execution.js';
import type { RuntimeEffectPolicy } from './runtime-policy.js';
import type { ControlledEffectEnvelope } from './runtime-policy.js';

export interface ExecutionWorkerDependencies {
  readonly persistence: ClaimHeartbeatPersistence;
  readonly now: () => string;
  readonly providerEffects?: Readonly<{
    policy: RuntimeEffectPolicy;
    connectors: EffectConnectorSelector;
    heartbeatIntervalMs: number;
  }>;
}

export type ExecutionWorkerResult =
  | ExecuteOperationResult
  | {
      readonly status: 'pre_dispatch_denied' | 'pre_dispatch_retryable';
      readonly reasonCode: string;
    };

function assertWorkerEvent(event: ExecutionWorkerEvent): void {
  if (
    event.operationId.length === 0 ||
    event.workerId.length === 0 ||
    !Number.isFinite(Date.parse(event.observedAt)) ||
    !Number.isSafeInteger(event.leaseDurationMs) ||
    event.leaseDurationMs < 1_000 ||
    event.leaseDurationMs > 15 * 60_000
  ) {
    throw new Error('INVALID_EXECUTION_WORKER_EVENT');
  }
}

export function createApprovalExecutionWorker(
  dependencies: ExecutionWorkerDependencies,
): (event: ExecutionWorkerEvent) => Promise<ExecutionWorkerResult> {
  return async (event) => {
    assertWorkerEvent(event);
    const providerEffects = dependencies.providerEffects;
    if (
      providerEffects !== undefined &&
      (!Number.isSafeInteger(providerEffects.heartbeatIntervalMs) ||
        providerEffects.heartbeatIntervalMs < 100 ||
        providerEffects.heartbeatIntervalMs * 2 >= event.leaseDurationMs)
    ) {
      throw new Error('INVALID_HEARTBEAT_INTERVAL');
    }
    let envelope: ControlledEffectEnvelope | undefined;
    let preDispatchOutcome: PreDispatchOutcome | undefined;
    const capture = new ClaimCapturingPersistence(
      dependencies.persistence,
      providerEffects === undefined
        ? undefined
        : async (claim, artifact) => {
            envelope = await providerEffects.policy.authorize(artifact);
            await dependencies.persistence.assertProviderBoundaryCurrent({
              claim,
              artifact,
              envelope,
              observedAt: dependencies.now(),
            });
            assertSelectedEffectConnector({
              connectors: providerEffects.connectors,
              envelope,
              artifact,
            });
          },
      async (claim, artifact, result) => {
        if (envelope?.kind !== 'work_management') {
          await dependencies.persistence.settleAcceptedAndCorrelation(
            claim,
            result,
          );
          return;
        }
        if (
          dependencies.persistence.settleAcceptedWorkManagementEffect ===
          undefined
        ) {
          throw new Error('ATOMIC_WORK_MANAGEMENT_LINK_PERSISTENCE_REQUIRED');
        }
        await dependencies.persistence.settleAcceptedWorkManagementEffect({
          claim,
          artifact,
          result,
        });
      },
      () => preDispatchOutcome,
    );
    const sink =
      providerEffects === undefined
        ? new EffectDisabledSink(dependencies.now)
        : new GuardedProviderExecutionSink({
            persistence: dependencies.persistence,
            claim: () => capture.capturedClaim,
            envelope: () => envelope,
            connectors: providerEffects.connectors,
            now: dependencies.now,
            heartbeatIntervalMs: providerEffects.heartbeatIntervalMs,
            leaseDurationMs: event.leaseDurationMs,
            recordPreDispatchOutcome: (outcome) => {
              preDispatchOutcome = outcome;
            },
          });

    const result = await executeApprovedOperation(capture, sink, {
      operationId: event.operationId,
      workerId: event.workerId,
      observedAt: event.observedAt,
      leaseDurationMs: event.leaseDurationMs,
    });
    if (
      result.status === 'reconciliation_required' &&
      preDispatchOutcome !== undefined
    ) {
      return {
        status:
          preDispatchOutcome.disposition === 'denied'
            ? 'pre_dispatch_denied'
            : 'pre_dispatch_retryable',
        reasonCode: preDispatchOutcome.reasonCode,
      };
    }
    return result;
  };
}

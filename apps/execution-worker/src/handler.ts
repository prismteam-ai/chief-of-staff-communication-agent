import {
  type WorkerFoundationResult,
  workerFoundationResultSchema,
} from '@chief/contracts';
import { createObservability } from '@chief/observability';
import {
  EffectDisabledSink,
  executeApprovedOperation,
  type ApprovalExecutionPersistence,
  type ExecuteOperationResult,
} from '@chief/approval-outbox/execution-service';
import type { OperationId } from '@chief/contracts/ids';

const observability = createObservability('chief-execution-worker');

export function invokeFoundationWorker(): WorkerFoundationResult {
  observability.logger.info('Non-effectful foundation invocation');
  return workerFoundationResultSchema.parse({
    worker: 'execution-worker',
    status: 'foundation-ready',
    externalEffects: 'disabled',
  });
}

export interface ExecutionWorkerEvent {
  readonly operationId: OperationId;
  readonly workerId: string;
  readonly observedAt: string;
  readonly leaseDurationMs: number;
}

export function createEffectDisabledExecutionWorker(input: {
  readonly persistence: ApprovalExecutionPersistence;
  readonly now: () => string;
}): (event: ExecutionWorkerEvent) => Promise<ExecuteOperationResult> {
  const sink = new EffectDisabledSink(input.now);
  return (event) =>
    executeApprovedOperation(input.persistence, sink, {
      operationId: event.operationId,
      workerId: event.workerId,
      observedAt: event.observedAt,
      leaseDurationMs: event.leaseDurationMs,
    });
}

export const handler = invokeFoundationWorker;

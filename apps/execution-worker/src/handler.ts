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

import { createApprovalExecutionWorker } from './execution-worker.js';
import {
  createSqsExecutionHandler,
  type SqsBatchResponse,
  type SqsExecutionEvent,
} from './sqs-handler.js';
import type { ExecutionWorkerDependencies } from './execution-worker.js';

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

export function createExecutionWorkerLambda(input: {
  readonly dependencies: ExecutionWorkerDependencies;
  readonly workerId: string;
  readonly defaultLeaseDurationMs: number;
}): (event: SqsExecutionEvent) => Promise<SqsBatchResponse> {
  return createSqsExecutionHandler(
    createApprovalExecutionWorker(input.dependencies),
    {
      workerId: input.workerId,
      now: input.dependencies.now,
      defaultLeaseDurationMs: input.defaultLeaseDurationMs,
    },
  );
}

/**
 * Deployment composition injects the DynamoDB-backed repository and selected
 * adapters through `createExecutionWorkerLambda`. The unconfigured module
 * handler fails every record for safe SQS redrive and never performs an effect.
 */
export function handler(event: SqsExecutionEvent): Promise<SqsBatchResponse> {
  observability.logger.error(
    'Execution worker dependencies are not configured',
  );
  return Promise.resolve({
    batchItemFailures: event.Records.map(({ messageId }) => ({
      itemIdentifier: messageId,
    })),
  });
}

export * from './execution-worker.js';
export * from './feedback-closure.js';
export * from './provider-execution.js';
export * from './reconciliation.js';
export * from './runtime-policy.js';
export * from './sqs-handler.js';

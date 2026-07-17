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
import {
  createAwsEffectDisabledExecutionHandler,
  type AwsExecutionCompositionDependencies,
} from './aws-composition.js';
import { ExecutionConfigurationError } from './runtime-config.js';

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

export interface ProductionExecutionModuleHandlerOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dependencies?: AwsExecutionCompositionDependencies;
}

function failEveryRecord(event: SqsExecutionEvent): SqsBatchResponse {
  const records: unknown = event?.Records;
  if (!Array.isArray(records)) return { batchItemFailures: [] };
  return {
    batchItemFailures: records.flatMap((record: unknown) => {
      if (
        record === null ||
        typeof record !== 'object' ||
        !('messageId' in record) ||
        typeof record.messageId !== 'string' ||
        record.messageId.length === 0
      ) {
        return [];
      }
      return [{ itemIdentifier: record.messageId }];
    }),
  };
}

export function createProductionExecutionModuleHandler(
  options: ProductionExecutionModuleHandlerOptions,
): (event: SqsExecutionEvent) => Promise<SqsBatchResponse> {
  let configured:
    ((event: SqsExecutionEvent) => Promise<SqsBatchResponse>) | undefined;
  return async (event) => {
    try {
      configured ??= createAwsEffectDisabledExecutionHandler(
        options.environment,
        options.dependencies,
      );
      return await configured(event);
    } catch (error) {
      observability.logger.error('Execution record failed closed', {
        reasonCode:
          error instanceof ExecutionConfigurationError
            ? error.code
            : 'EXECUTION_RECORD_PROCESSING_FAILED',
      });
      return failEveryRecord(event);
    }
  };
}

/**
 * Production entry point. Configuration and the DynamoDB client are resolved
 * lazily, and there is no fixture, connector, provider endpoint, or credential
 * fallback. Any configuration/composition failure returns every SQS record for
 * redrive.
 */
export const handler = createProductionExecutionModuleHandler({
  environment: process.env,
});

export * from './execution-worker.js';
export * from './aws-composition.js';
export * from './feedback-closure.js';
export * from './provider-execution.js';
export * from './reconciliation.js';
export * from './runtime-policy.js';
export * from './runtime-config.js';
export * from './sqs-handler.js';

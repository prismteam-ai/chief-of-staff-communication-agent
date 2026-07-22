import { operationIdSchema, type OperationId } from '@chief/contracts/ids';

import type { ExecutionWorkerEvent } from './handler.js';

export interface SqsExecutionRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsExecutionEvent {
  readonly Records: readonly SqsExecutionRecord[];
}

export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export interface SqsExecutionPayload {
  readonly operationId: OperationId;
}

export interface SqsHandlerOptions {
  readonly workerId: string;
  readonly now: () => string;
  readonly defaultLeaseDurationMs: number;
  readonly maxBatchSize?: number;
}

function isSqsExecutionRecord(value: unknown): value is SqsExecutionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.messageId === 'string' &&
    candidate.messageId.length > 0 &&
    typeof candidate.body === 'string'
  );
}

function parsePayload(body: string): SqsExecutionPayload {
  if (Buffer.byteLength(body, 'utf8') > 16 * 1_024) {
    throw new Error('EXECUTION_MESSAGE_TOO_LARGE');
  }
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_EXECUTION_MESSAGE');
  }
  const candidate = parsed as Record<string, unknown>;
  const allowed = new Set(['operationId']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new Error('UNEXPECTED_EXECUTION_MESSAGE_AUTHORITY');
  }
  const operationId = operationIdSchema.parse(candidate.operationId);
  return { operationId };
}

function isRetryablePreDispatchResult(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'status' in value &&
    value.status === 'pre_dispatch_retryable'
  );
}

export function createSqsExecutionHandler(
  execute: (event: ExecutionWorkerEvent) => Promise<unknown>,
  options: SqsHandlerOptions,
): (event: SqsExecutionEvent) => Promise<SqsBatchResponse> {
  const maxBatchSize = options.maxBatchSize ?? 10;
  if (
    !Number.isSafeInteger(maxBatchSize) ||
    maxBatchSize < 1 ||
    maxBatchSize > 10
  ) {
    throw new Error('INVALID_SQS_BATCH_SIZE');
  }
  return async (event) => {
    const records: unknown = event.Records;
    if (
      !Array.isArray(records) ||
      records.length > maxBatchSize ||
      !records.every(isSqsExecutionRecord)
    ) {
      throw new Error('INVALID_SQS_EXECUTION_BATCH');
    }
    const validatedRecords: readonly SqsExecutionRecord[] = records;

    const results = await Promise.allSettled(
      validatedRecords.map(async (record) => {
        const payload = parsePayload(record.body);
        const result = await execute({
          operationId: payload.operationId,
          workerId: options.workerId,
          observedAt: options.now(),
          leaseDurationMs: options.defaultLeaseDurationMs,
        });
        if (isRetryablePreDispatchResult(result)) {
          throw new Error('PRE_DISPATCH_RETRYABLE');
        }
      }),
    );

    return {
      batchItemFailures: results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{ itemIdentifier: validatedRecords[index]?.messageId ?? '' }]
          : [],
      ),
    };
  };
}

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoApprovalExecutionPersistence } from '@chief/approval-outbox/dynamo-execution-persistence';
import {
  EffectDisabledSink,
  executeApprovedOperation,
} from '@chief/approval-outbox/execution-service';

import type { ExecutionWorkerEvent } from './handler.js';
import {
  loadProductionExecutionConfig,
  type ProductionExecutionConfig,
} from './runtime-config.js';
import {
  createSqsExecutionHandler,
  type SqsBatchResponse,
  type SqsExecutionEvent,
} from './sqs-handler.js';

export interface AwsExecutionCompositionDependencies {
  readonly documentClient?: DynamoDBDocumentClient;
  readonly now?: () => string;
}

export function createAwsEffectDisabledExecutionHandler(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: AwsExecutionCompositionDependencies = {},
): (event: SqsExecutionEvent) => Promise<SqsBatchResponse> {
  const config: ProductionExecutionConfig =
    loadProductionExecutionConfig(environment);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const documentClient =
    dependencies.documentClient ??
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const persistence = new DynamoApprovalExecutionPersistence({
    client: documentClient,
    coreTableName: config.coreTableName,
    now,
  });
  const sink = new EffectDisabledSink(now);
  const execute = (event: ExecutionWorkerEvent) =>
    executeApprovedOperation(persistence, sink, event);
  return createSqsExecutionHandler(
    (event: ExecutionWorkerEvent) => execute(event),
    {
      workerId: config.workerId,
      now,
      defaultLeaseDurationMs: config.leaseDurationMs,
    },
  );
}

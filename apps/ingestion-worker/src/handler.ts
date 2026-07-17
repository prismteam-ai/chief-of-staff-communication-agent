import {
  type WorkerFoundationResult,
  workerFoundationResultSchema,
} from '@chief/contracts';
import { createObservability } from '@chief/observability';

const observability = createObservability('chief-ingestion-worker');

export function invokeFoundationWorker(): WorkerFoundationResult {
  observability.logger.info('Non-effectful foundation invocation');
  return workerFoundationResultSchema.parse({
    worker: 'ingestion-worker',
    status: 'foundation-ready',
    externalEffects: 'disabled',
  });
}

export const handler = invokeFoundationWorker;

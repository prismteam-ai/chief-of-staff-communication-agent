import {
  type WorkerFoundationResult,
  workerFoundationResultSchema,
} from '@chief/contracts';
import { createObservability } from '@chief/observability';

const observability = createObservability('chief-execution-worker');

export function invokeFoundationWorker(): WorkerFoundationResult {
  observability.logger.info('Non-effectful foundation invocation');
  return workerFoundationResultSchema.parse({
    worker: 'execution-worker',
    status: 'foundation-ready',
    externalEffects: 'disabled',
  });
}

export const handler = invokeFoundationWorker;

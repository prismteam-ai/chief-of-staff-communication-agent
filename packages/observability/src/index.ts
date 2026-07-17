import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

export interface Observability {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
}

export function createObservability(serviceName: string): Observability {
  return {
    logger: new Logger({ serviceName }),
    metrics: new Metrics({
      serviceName,
      namespace: 'ChiefFoundation',
    }),
    tracer: new Tracer({ serviceName }),
  };
}

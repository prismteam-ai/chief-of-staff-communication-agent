import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

export interface Observability {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
}

const DEFAULT_METRICS_NAMESPACE = 'ChiefFoundation';

export function createObservability(
  serviceName: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Observability {
  const configuredNamespace = environment.POWERTOOLS_METRICS_NAMESPACE?.trim();
  return {
    logger: new Logger({ serviceName }),
    metrics: new Metrics({
      serviceName,
      namespace:
        configuredNamespace === undefined || configuredNamespace.length === 0
          ? DEFAULT_METRICS_NAMESPACE
          : configuredNamespace,
    }),
    tracer: new Tracer({ serviceName }),
  };
}

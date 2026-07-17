import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics } from '@aws-lambda-powertools/metrics';

export const SERVICE_NAME = 'chief-of-staff-ingest';
export const METRICS_NAMESPACE = 'ChiefOfStaffIngest';

/**
 * One Logger/Tracer/Metrics instance per Lambda module (brief constraint 4: Powertools
 * Logger+Tracer+Metrics on both Lambdas). Log hygiene is enforced by convention across this app:
 * log message ids and metadata shapes (channel, account id, byte counts), never message bodies or
 * participant addresses (brief constraint 4: "no secrets/PII in logs").
 */
export const logger = new Logger({ serviceName: SERVICE_NAME });
export const tracer = new Tracer({ serviceName: SERVICE_NAME });
export const metrics = new Metrics({ serviceName: SERVICE_NAME, namespace: METRICS_NAMESPACE });

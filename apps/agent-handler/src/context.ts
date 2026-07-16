import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics } from '@aws-lambda-powertools/metrics';

export const SERVICE_NAME = 'chief-of-staff-agent';
export const METRICS_NAMESPACE = 'ChiefOfStaffAgent';

/**
 * One Logger/Tracer/Metrics instance per Lambda module (Task 5 constraint 6: Powertools
 * Logger+Tracer+Metrics on the agent Lambda). Log hygiene is enforced by convention across this
 * app, exactly as `apps/ingest/src/context.ts` does it: log ids, action types, confidence scores,
 * and token counts — NEVER message bodies, participant addresses, draft text, or any other PII.
 */
export const logger = new Logger({ serviceName: SERVICE_NAME });
export const tracer = new Tracer({ serviceName: SERVICE_NAME });
export const metrics = new Metrics({ serviceName: SERVICE_NAME, namespace: METRICS_NAMESPACE });

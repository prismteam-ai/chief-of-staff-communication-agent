import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';

export interface HealthResult {
  ok: true;
  ts: string;
}

/**
 * Pure handler logic for the health check, kept independent of tRPC so it is
 * directly unit-testable and reusable if the transport ever changes.
 */
export function getHealth(ctx: Pick<Context, 'logger' | 'metrics'>): HealthResult {
  ctx.logger.info('Health check requested');
  ctx.metrics.addMetric('RequestProcessed', MetricUnit.Count, 1);
  return { ok: true, ts: new Date().toISOString() };
}

export const healthRouter = router({
  check: publicProcedure.query(({ ctx }) => getHealth(ctx)),
});

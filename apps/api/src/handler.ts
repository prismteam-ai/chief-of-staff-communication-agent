import middy from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context as LambdaContext,
} from 'aws-lambda';
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { appRouter } from './routers/index.js';
import { createContext, logger, metrics, tracer } from './context.js';

const trpcHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext,
  onError: ({ error, path }) => {
    logger.error('tRPC procedure failed', { path, error: error.message });
    metrics.addMetric('RequestFailed', MetricUnit.Count, 1);
  },
});

async function baseHandler(
  event: APIGatewayProxyEventV2,
  context: LambdaContext,
): Promise<APIGatewayProxyResultV2> {
  const start = Date.now();
  try {
    return await trpcHandler(event, context);
  } finally {
    metrics.addMetric('ProcessingDuration', MetricUnit.Milliseconds, Date.now() - start);
  }
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger, { logEvent: false }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));

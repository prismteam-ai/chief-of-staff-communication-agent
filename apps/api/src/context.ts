import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CreateAWSLambdaContextOptions } from '@trpc/server/adapters/aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics } from '@aws-lambda-powertools/metrics';

export const SERVICE_NAME = 'chief-of-staff-api';

export const logger = new Logger({ serviceName: SERVICE_NAME });
export const tracer = new Tracer({ serviceName: SERVICE_NAME });
export const metrics = new Metrics({
  serviceName: SERVICE_NAME,
  namespace: 'ChiefOfStaffApi',
});

export const createContext = ({
  event,
  context,
}: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>) => ({
  event,
  context,
  logger,
  tracer,
  metrics,
});

export type Context = Awaited<ReturnType<typeof createContext>>;

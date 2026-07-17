import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CreateAWSLambdaContextOptions } from '@trpc/server/adapters/aws-lambda';

import { createObservability } from '@chief/observability';

const observability = createObservability('chief-api');

export function createContext({
  event,
  context,
}: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>) {
  return {
    event,
    lambdaContext: context,
    observability,
  };
}

export type ApiContext = Awaited<ReturnType<typeof createContext>>;

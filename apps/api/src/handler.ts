import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda';

import {
  createContextFactory,
  defaultApiDependencies,
  type ApiDependencies,
} from './context.js';
import { appRouter } from './router.js';

export function createApiHandler(
  dependencies: ApiDependencies = defaultApiDependencies,
) {
  const trpcHandler = awsLambdaRequestHandler({
    router: appRouter,
    createContext: createContextFactory(dependencies),
  });
  return async (
    ...parameters: Parameters<typeof trpcHandler>
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const [event] = parameters;
    if (event.rawPath === '/auth' || event.rawPath.startsWith('/auth/')) {
      return (
        dependencies.browserAuthHandler?.handle(event) ??
        Promise.resolve({
          statusCode: 404,
          headers: { 'cache-control': 'no-store, max-age=0' },
        })
      );
    }
    return trpcHandler(...parameters);
  };
}

export const handler = createApiHandler();

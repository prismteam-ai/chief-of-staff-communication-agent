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
  return awsLambdaRequestHandler({
    router: appRouter,
    createContext: createContextFactory(dependencies),
  });
}

export const handler = createApiHandler();

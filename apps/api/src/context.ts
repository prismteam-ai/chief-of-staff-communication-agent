import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CreateAWSLambdaContextOptions } from '@trpc/server/adapters/aws-lambda';
import { TRPCError } from '@trpc/server';

import { createObservability } from '@chief/observability';

import {
  createFixtureProductService,
  createFixtureRequestContext,
} from './fixture-product-service.js';
import type {
  ProductRequestContext,
  ProductService,
} from './product-service.js';

const observability = createObservability('chief-api');

const forbiddenAuthorityHeaders = new Set([
  'x-account-id',
  'x-chief-account-id',
  'x-chief-tenant-id',
  'x-provider',
  'x-provider-account',
  'x-raw-path',
  'x-sql',
  'x-table-name',
  'x-tenant-id',
]);

export interface ApiDependencies {
  readonly productService: ProductService;
  readonly requestContext: ProductRequestContext;
}

export const defaultApiDependencies: ApiDependencies = Object.freeze({
  productService: createFixtureProductService(process.env.PRODUCT_BASE_URL),
  requestContext: createFixtureRequestContext(),
});

function assertNoCallerAuthority(
  headers: Readonly<Record<string, string | undefined>>,
): void {
  const attemptedHeader = Object.keys(headers).find((header) =>
    forbiddenAuthorityHeaders.has(header.toLocaleLowerCase('en-US')),
  );
  if (attemptedHeader !== undefined) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Tenant, account, provider, and storage authority are server-selected.',
    });
  }
}

export function createContext(
  { event, context }: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>,
  dependencies = defaultApiDependencies,
) {
  assertNoCallerAuthority(event.headers);
  return {
    event,
    lambdaContext: context,
    observability,
    productService: dependencies.productService,
    requestContext: dependencies.requestContext,
  };
}

export function createContextFactory(dependencies: ApiDependencies) {
  return (options: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>) =>
    createContext(options, dependencies);
}

export type ApiContext = Awaited<ReturnType<typeof createContext>>;

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CreateAWSLambdaContextOptions } from '@trpc/server/adapters/aws-lambda';
import { TRPCError } from '@trpc/server';

import { createObservability } from '@chief/observability';

import { createDefaultDurableApiDependencies } from './aws-composition.js';
import {
  createDenyAllRequestAuthorityResolver,
  createLocalTestRequestAuthorityResolver,
  requestAuthorityInput,
  type RequestAuthMode,
  type RequestAuthorityResolver,
  type ResolvedRequestAuthority,
} from './auth/index.js';
import type {
  ProductRequestContext,
  ProductService,
} from './product-service.js';
import type { BrowserAuthHandler } from './auth/browser-auth.js';

const observability = createObservability('chief-api');

const forbiddenAuthorityHeaders = new Set([
  'x-account-id',
  'x-chief-account-id',
  'x-chief-authority',
  'x-chief-grants',
  'x-chief-membership-version',
  'x-chief-scope-hash',
  'x-chief-tenant-id',
  'x-chief-user-id',
  'x-authorization-epoch',
  'x-brand-id',
  'x-grants',
  'x-membership-version',
  'x-provider',
  'x-provider-account',
  'x-raw-path',
  'x-sql',
  'x-table-name',
  'x-tenant-id',
  'x-user-id',
]);

export interface ApiDependencies {
  readonly productService: ProductService;
  /** Legacy product-service input. Ignored unless authMode is explicitly local-test. */
  readonly requestContext: ProductRequestContext;
  readonly requestAuthorityResolver?: RequestAuthorityResolver;
  readonly authMode?: RequestAuthMode;
  readonly browserAuthHandler?: BrowserAuthHandler;
}

export const defaultApiDependencies: ApiDependencies = Object.freeze(
  createDefaultDurableApiDependencies(),
);

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
  const authMode = dependencies.authMode ?? 'enforced';
  if (authMode === 'local-test' && process.env.NODE_ENV === 'production')
    throw new Error('LOCAL_TEST_AUTH_FORBIDDEN_IN_PRODUCTION');
  if (
    authMode === 'local-test' &&
    dependencies.requestAuthorityResolver !== undefined
  )
    throw new Error('INVALID_LOCAL_TEST_AUTH_CONFIGURATION');
  const requestAuthorityResolver =
    authMode === 'local-test'
      ? createLocalTestRequestAuthorityResolver(dependencies.requestContext)
      : (dependencies.requestAuthorityResolver ??
        createDenyAllRequestAuthorityResolver());
  const authorityInput = requestAuthorityInput(event);
  let requestAuthority: Promise<ResolvedRequestAuthority> | undefined;
  return {
    lambdaContext: context,
    observability,
    productService: dependencies.productService,
    authMode,
    resolveRequestAuthority: () =>
      (requestAuthority ??= requestAuthorityResolver.resolve(authorityInput)),
  };
}

export function createContextFactory(dependencies: ApiDependencies) {
  return (options: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>) =>
    createContext(options, dependencies);
}

export type ApiContext = Awaited<ReturnType<typeof createContext>>;

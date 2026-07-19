import { createTRPCClient, httpBatchLink, type TRPCClient } from '@trpc/client';

import type { AppRouter } from '@chief/api';

export type { AppRouter };

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly headers?: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
}

export class BrowserAuthenticationRequiredError extends Error {
  public override readonly name = 'BrowserAuthenticationRequiredError';

  public constructor() {
    super('BROWSER_AUTHENTICATION_REQUIRED');
  }
}

export class BrowserApiNetworkError extends Error {
  public override readonly name = 'BrowserApiNetworkError';

  public constructor(cause: unknown) {
    super('BROWSER_API_NETWORK_ERROR', { cause });
  }
}

type BrowserHeaders = ConstructorParameters<typeof Headers>[0];

function assertNoAuthorizationHeader(
  headers: BrowserHeaders | undefined,
): void {
  if (headers !== undefined && new Headers(headers).has('authorization')) {
    throw new Error('BROWSER_AUTHORIZATION_HEADER_FORBIDDEN');
  }
}

function browserFetch(fetchImplementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertNoAuthorizationHeader(init?.headers);
    let response: Response;
    try {
      response = await fetchImplementation(input, {
        ...init,
        credentials: 'include',
      });
    } catch (error) {
      if (error instanceof BrowserAuthenticationRequiredError) throw error;
      throw new BrowserApiNetworkError(error);
    }
    if (response.status === 401) {
      throw new BrowserAuthenticationRequiredError();
    }
    return response;
  };
}

export function createApiClient(
  options: ApiClientOptions,
): TRPCClient<AppRouter> {
  const headers =
    options.headers === undefined
      ? undefined
      : async () => {
          const resolved = await options.headers?.();
          assertNoAuthorizationHeader(resolved);
          return resolved ?? {};
        };
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${options.baseUrl.replace(/\/$/u, '')}/trpc`,
        fetch: browserFetch(options.fetch ?? globalThis.fetch),
        ...(headers === undefined ? {} : { headers }),
      }),
    ],
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Generated-style route surface for consumers that do not need a React
 * provider. The AppRouter export is the single source of procedure types.
 */
export const apiRoutes = Object.freeze({
  agent: ['recommend', 'createDraft', 'reviseDraft', 'requestContext'],
  approvals: ['prepare', 'prepareAsana', 'status'],
  communications: ['list', 'get', 'thread'],
  connectors: ['status'],
  dashboard: ['metrics', 'sla'],
  execution: ['status'],
  knowledge: ['search'],
  system: ['health'],
  work: ['relatedAsana'],
} as const);

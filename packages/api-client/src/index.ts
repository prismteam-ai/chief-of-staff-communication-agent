import { createTRPCClient, httpBatchLink, type TRPCClient } from '@trpc/client';

import type { AppRouter } from '@chief/api';

export type { AppRouter };

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly headers?: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
}

export function createApiClient(
  options: ApiClientOptions,
): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${options.baseUrl.replace(/\/$/u, '')}/trpc`,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
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

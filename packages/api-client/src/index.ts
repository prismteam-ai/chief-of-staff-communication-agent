import { createTRPCClient, httpBatchLink, type TRPCClient } from '@trpc/client';

import type { AppRouter } from '@chief/api';

export type { AppRouter };

export interface ApiClientOptions {
  readonly baseUrl: string;
}

export function createApiClient(
  options: ApiClientOptions,
): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${options.baseUrl.replace(/\/$/u, '')}/trpc`,
      }),
    ],
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

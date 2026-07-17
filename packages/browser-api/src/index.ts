import { createApiClient } from '@chief/api-client';
import { healthResponseSchema, type HealthResponse } from '@chief/contracts';

export interface BrowserApi {
  systemHealth(): Promise<HealthResponse>;
}

export function createBrowserApi(baseUrl: string): BrowserApi {
  const client = createApiClient({ baseUrl });

  return {
    async systemHealth() {
      return healthResponseSchema.parse(await client.system.health.query());
    },
  };
}

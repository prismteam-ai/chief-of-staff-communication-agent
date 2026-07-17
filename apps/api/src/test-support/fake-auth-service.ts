import { vi } from 'vitest';
import { McpAuthService } from '../services/mcp-auth-service.js';

/**
 * A real `McpAuthService` backed by an in-memory token store — used by every dashboard/MCP router
 * integration test that needs to prove the bearer-token gate for real (Task 8.5 brief constraint
 * 7: "every dashboard procedure REJECTS a call with no token / forged token / other-user token").
 * Deliberately the REAL service class, not a hand-rolled fake `verify` — these tests exercise the
 * actual hash-and-lookup path `authedMiddleware` calls in production, just against an in-memory
 * repo instead of DynamoDB (same "real class, fake repo" pattern `mcp.integration.test.ts` uses).
 */
export function fakeAuthService(): McpAuthService {
  const store = new Map<
    string,
    { tokenHash: string; userId: string; label: string; createdAt: string; revokedAt?: string }
  >();
  return new McpAuthService({
    tokensRepo: {
      async put(record) {
        store.set(record.tokenHash, record);
      },
      async getByHash(hash) {
        return store.get(hash);
      },
      async touchLastUsed() {},
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metricsClient: { addMetric: vi.fn() },
  });
}

/** Mints a token for `userId` and returns the bearer-token context field it authenticates as. */
export async function issueBearerToken(
  authService: McpAuthService,
  userId: string,
  label = 'test',
): Promise<string> {
  const issued = await authService.issue({ userId, label });
  return issued.token;
}

export const FORGED_TOKEN = 'cos_mcp_' + 'f'.repeat(64);

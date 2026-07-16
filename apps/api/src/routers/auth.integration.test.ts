import { describe, expect, it, vi } from 'vitest';
import { createAuthRouter } from './auth.js';
import { DashboardLoginService, hashCredential } from '../services/dashboard-login-service.js';
import { fakeAuthService } from '../test-support/fake-auth-service.js';
import type { Context } from '../context.js';

/**
 * Integration test for the dashboard `login` tRPC procedure (Task 8.5): drives the ACTUAL router
 * surface, not just `DashboardLoginService` in isolation — proves a client can obtain a real,
 * verifiable session token through the exact same tRPC contract the browser calls, and that the
 * token really does verify against the shared `McpAuthService` afterward (not just a shape check).
 */

const DEMO_USERNAME = 'demo-alex';
const DEMO_PASSWORD = 'super-secret-demo-password';
const DEMO_USER_ID = 'demo-alex';

function buildRouter() {
  const authService = fakeAuthService();
  const loginService = new DashboardLoginService({
    authService,
    loadCredentials: async () => [
      { username: DEMO_USERNAME, passwordHash: hashCredential(DEMO_PASSWORD), userId: DEMO_USER_ID },
    ],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metricsClient: { addMetric: vi.fn() },
  });
  const router = createAuthRouter(() => loginService);
  return { router, authService };
}

describe('auth router — login', () => {
  it('issues a real, verifiable session token for the demo credential', async () => {
    const { router, authService } = buildRouter();
    const caller = router.createCaller({} as Context);

    const result = await caller.login({ username: DEMO_USERNAME, password: DEMO_PASSWORD });

    expect(result.userId).toBe(DEMO_USER_ID);
    expect(result.token).toBeTruthy();
    await expect(authService.verify(result.token)).resolves.toBe(DEMO_USER_ID);
  });

  it('rejects an invalid password', async () => {
    const { router } = buildRouter();
    const caller = router.createCaller({} as Context);

    await expect(
      caller.login({ username: DEMO_USERNAME, password: 'not-the-password' }),
    ).rejects.toThrow();
  });

  it('rejects an unknown username', async () => {
    const { router } = buildRouter();
    const caller = router.createCaller({} as Context);

    await expect(
      caller.login({ username: 'not-a-real-user', password: DEMO_PASSWORD }),
    ).rejects.toThrow();
  });
});

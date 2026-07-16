import { describe, expect, it, vi } from 'vitest';
import { DashboardLoginInvalidError } from '@chief-of-staff/shared';
import { DashboardLoginService, hashCredential } from './dashboard-login-service.js';
import type { McpAuthService } from './mcp-auth-service.js';

/**
 * Unit tests for the demo-credential login gate (Task 8.5, brief constraint 2: "Keep it SIMPLE
 * but REAL — the point is the server issues the token after verifying a credential the client
 * couldn't forge"). `DashboardLoginService` owns exactly one decision — does this
 * username/password pair match the operator-provisioned demo credential? — then delegates token
 * minting to the SAME `McpAuthService.issue` Task 11 already built (see that class's doc comment:
 * one token table, two issuance entry points).
 */

function fakeAuthService(): Pick<McpAuthService, 'issue'> {
  return { issue: vi.fn(async (input) => ({ ...input, token: 'cos_mcp_faketoken', tokenHash: 'h', createdAt: '2026-07-16T00:00:00.000Z' })) };
}

const DEMO_USERNAME = 'demo-alex';
const DEMO_PASSWORD = 'correct-demo-password';
const DEMO_USER_ID = 'demo-alex';

function service(authService: Pick<McpAuthService, 'issue'>) {
  return new DashboardLoginService({
    authService,
    loadCredentials: async () => [
      {
        username: DEMO_USERNAME,
        passwordHash: hashCredential(DEMO_PASSWORD),
        userId: DEMO_USER_ID,
      },
    ],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metricsClient: { addMetric: vi.fn() },
  });
}

describe('DashboardLoginService — login', () => {
  it('issues a session token for a valid username/password', async () => {
    const authService = fakeAuthService();
    const result = await service(authService).login({
      username: DEMO_USERNAME,
      password: DEMO_PASSWORD,
    });

    expect(result.userId).toBe(DEMO_USER_ID);
    expect(result.token).toBe('cos_mcp_faketoken');
    expect(authService.issue).toHaveBeenCalledWith({
      userId: DEMO_USER_ID,
      label: 'dashboard session',
    });
  });

  it('rejects an unknown username', async () => {
    const authService = fakeAuthService();
    await expect(
      service(authService).login({ username: 'nobody', password: DEMO_PASSWORD }),
    ).rejects.toThrow(DashboardLoginInvalidError);
    expect(authService.issue).not.toHaveBeenCalled();
  });

  it('rejects a wrong password for a known username', async () => {
    const authService = fakeAuthService();
    await expect(
      service(authService).login({ username: DEMO_USERNAME, password: 'wrong-password' }),
    ).rejects.toThrow(DashboardLoginInvalidError);
    expect(authService.issue).not.toHaveBeenCalled();
  });

  it('rejects an empty credentials list (secret not provisioned) without crashing', async () => {
    const authService = fakeAuthService();
    const svc = new DashboardLoginService({
      authService,
      loadCredentials: async () => [],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metricsClient: { addMetric: vi.fn() },
    });
    await expect(svc.login({ username: DEMO_USERNAME, password: DEMO_PASSWORD })).rejects.toThrow(
      DashboardLoginInvalidError,
    );
  });
});

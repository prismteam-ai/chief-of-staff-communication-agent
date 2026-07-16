import { test, expect } from '@playwright/test';
import { mockDashboardApi, FIXTURE_API_URL } from '../fixtures/mock-api.js';

/**
 * Login-flow coverage (Task 8.5): unlike `dashboard-views.spec.ts`, this spec does NOT preseed a
 * session token — it drives the real `LoginView` form against mocked `auth.login`/dashboard
 * routes, proving the UI login round trip end to end (form submit -> token stored -> dashboard
 * renders) and that a rejected login shows an error without ever reaching the dashboard views.
 */

test.describe('login flow', () => {
  test('submitting valid credentials logs in and reveals the dashboard tabs', async ({ page }) => {
    await mockDashboardApi(page);
    await page.addInitScript(
      (apiUrl: string) => window.localStorage.setItem('cos.apiUrl', apiUrl),
      FIXTURE_API_URL,
    );
    await page.goto('/');

    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect(page.getByTestId('tab-metrics')).toHaveCount(0);

    await page.getByTestId('login-username').fill('demo-alex');
    await page.getByTestId('login-password').fill('correct-demo-password');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('tab-metrics')).toBeVisible();
    await expect(page.getByTestId('session-user')).toContainText('demo-alex');
    await expect(page.getByTestId('login-view')).toHaveCount(0);

    // The Authorization header carries the token — no userId anywhere in the request body.
    const stored = await page.evaluate(() => window.localStorage.getItem('cos.sessionToken'));
    expect(stored).toBeTruthy();
  });

  test('rejected login shows an error and never reveals the dashboard', async ({ page }) => {
    await page.route('**/auth.login*', async (route) => {
      await route.fulfill({
        status: 401,
        json: { error: { message: 'Invalid username or password.', code: 'UNAUTHORIZED' } },
      });
    });
    await page.addInitScript(
      (apiUrl: string) => window.localStorage.setItem('cos.apiUrl', apiUrl),
      FIXTURE_API_URL,
    );
    await page.goto('/');

    await page.getByTestId('login-username').fill('demo-alex');
    await page.getByTestId('login-password').fill('wrong-password');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toContainText(/invalid/i);
    await expect(page.getByTestId('tab-metrics')).toHaveCount(0);
  });

  test('a 401 on a dashboard call drops the session back to the login screen', async ({ page }) => {
    await mockDashboardApi(page);
    // Override the metrics route to simulate an expired/invalid token after login.
    await page.route('**/metrics.getDashboardMetrics*', async (route) => {
      await route.fulfill({
        status: 401,
        json: {
          error: { message: 'MCP token is invalid, revoked, or unknown.', code: 'UNAUTHORIZED' },
        },
      });
    });
    await page.addInitScript(
      (init: { apiUrl: string; accountId: string; sessionToken: string; userId: string }) => {
        window.localStorage.setItem('cos.apiUrl', init.apiUrl);
        window.localStorage.setItem('cos.accountId', init.accountId);
        window.localStorage.setItem('cos.sessionToken', init.sessionToken);
        window.localStorage.setItem('cos.sessionUserId', init.userId);
      },
      {
        apiUrl: FIXTURE_API_URL,
        accountId: 'acct-gmail-demoalex775',
        sessionToken: 'cos_mcp_expiredexpiredexpiredexpiredexpiredexpiredexpiredexpired01',
        userId: 'demo-alex',
      },
    );
    await page.goto('/');

    await expect(page.getByTestId('login-view')).toBeVisible({ timeout: 10_000 });
    const stored = await page.evaluate(() => window.localStorage.getItem('cos.sessionToken'));
    expect(stored).toBeNull();
  });
});

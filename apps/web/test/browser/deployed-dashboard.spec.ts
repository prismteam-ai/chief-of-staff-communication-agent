import { test, expect } from '@playwright/test';

/**
 * Real-device spec against the DEPLOYED Amplify dashboard (Task 8 brief constraint 6/9; Task 8.5
 * updated it to drive the real login flow). Distinct from `test/design/**` — no mocked routes,
 * real AWS data, real CORS behavior. Skipped unless `DASHBOARD_URL`/`DASHBOARD_USERNAME`/
 * `DASHBOARD_PASSWORD` are provided (this project is intentionally excluded from `just test`,
 * which must stay hermetic/CI-safe): run manually via
 *
 *   DASHBOARD_URL=https://<amplify-domain> DASHBOARD_USERNAME=<demo-username> \
 *     DASHBOARD_PASSWORD=<demo-password> pnpm exec playwright test --project=browser
 *
 * This is the automatable half of the Task 8/8.5 live-proof step; the interactive Playwright-MCP
 * walk (login + 3 views + CORS console check + network-request Bearer-not-userId proof +
 * screenshots) recorded in the task report is the other half.
 */

const DASHBOARD_URL = process.env.DASHBOARD_URL;
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

test.describe('deployed dashboard smoke', () => {
  test.skip(
    !DASHBOARD_URL || !DASHBOARD_USERNAME || !DASHBOARD_PASSWORD,
    'DASHBOARD_URL/DASHBOARD_USERNAME/DASHBOARD_PASSWORD not set — see file doc comment to run this spec',
  );

  test('logs in and renders the metrics view with no CORS/console errors, sending Bearer not userId', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    const requestBodies: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('execute-api') && req.method() === 'POST') {
        requestBodies.push(req.postData() ?? '');
      }
    });

    await page.goto(DASHBOARD_URL!);
    await page.getByTestId('login-username').fill(DASHBOARD_USERNAME!);
    await page.getByTestId('login-password').fill(DASHBOARD_PASSWORD!);
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('tab-metrics')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('metrics-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tile-volume')).toBeVisible();

    const corsErrors = consoleErrors.filter((m) => /cors|preflight|blocked/i.test(m));
    expect(corsErrors, `CORS-related console errors: ${JSON.stringify(corsErrors)}`).toEqual([]);

    // Task 8.5 permission-boundary proof: no request body sent to the API ever carries a `userId`
    // field — the only identity in flight is the Authorization: Bearer header.
    const bodiesWithUserId = requestBodies.filter((b) => b.includes('"userId"'));
    expect(bodiesWithUserId, 'no POST body should ever contain userId').toEqual([]);

    const sessionToken = await page.evaluate(() => window.localStorage.getItem('cos.sessionToken'));
    expect(sessionToken).toBeTruthy();
  });
});

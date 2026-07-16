import { test, expect } from '@playwright/test';

/**
 * Real-device spec against the DEPLOYED Amplify dashboard (Task 8 brief constraint 6/9). Distinct
 * from `test/design/**` — no mocked routes, real AWS data, real CORS behavior. Skipped unless
 * `DASHBOARD_URL` is provided (this project is intentionally excluded from `just test`, which must
 * stay hermetic/CI-safe): run manually via
 *
 *   DASHBOARD_URL=https://<amplify-domain> pnpm exec playwright test --project=browser
 *
 * This is the automatable half of the Task 8 live-proof step; the interactive Playwright-MCP walk
 * (3 views + CORS console check + screenshots) recorded in the task report is the other half.
 */

const DASHBOARD_URL = process.env.DASHBOARD_URL;

test.describe('deployed dashboard smoke', () => {
  test.skip(!DASHBOARD_URL, 'DASHBOARD_URL not set — see file doc comment to run this spec');

  test('loads and renders the metrics view with no CORS/console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto(DASHBOARD_URL!);
    await page.getByTestId('tab-metrics').click();
    await expect(page.getByTestId('metrics-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tile-volume')).toBeVisible();

    const corsErrors = consoleErrors.filter((m) => /cors|preflight|blocked/i.test(m));
    expect(corsErrors, `CORS-related console errors: ${JSON.stringify(corsErrors)}`).toEqual([]);
  });
});

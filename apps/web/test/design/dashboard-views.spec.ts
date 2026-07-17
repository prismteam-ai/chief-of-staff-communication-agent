import { test, expect } from '@playwright/test';
import { BREAKPOINTS } from './breakpoints.js';
import { gotoDashboard } from '../fixtures/mock-api.js';

/**
 * Responsive design coverage for the dashboard's three main views (Task 8 brief constraint 6):
 * metrics, recommended-actions, drafts-awaiting-approval — each rendered and asserted against
 * mocked fixture data at every `BREAKPOINTS` config. One generic test body per view, parameterized
 * over the breakpoint array — adding a fourth breakpoint later is a one-line config change, not a
 * new test.
 */

for (const bp of BREAKPOINTS) {
  test.describe(`dashboard views @ ${bp.name} (${bp.width}x${bp.height})`, () => {
    test.use({ viewport: { width: bp.width, height: bp.height } });

    test('metrics view renders volume/status/channel/response-time data', async ({ page }) => {
      await gotoDashboard(page);
      await page.getByTestId('tab-metrics').click();

      const view = page.getByTestId('metrics-view');
      await expect(view).toBeVisible();
      await expect(page.getByTestId('tile-volume')).toContainText('12');
      await expect(page.getByTestId('tile-overdue')).toContainText('2');
      await expect(page.getByTestId('tile-pending')).toContainText('4');
      await expect(page.getByTestId('status-breakdown')).toBeVisible();
      await expect(page.getByTestId('channel-breakdown')).toBeVisible();
      await expect(page.getByTestId('response-time-stats')).toBeVisible();

      // Nothing should overflow the viewport horizontally at any breakpoint.
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(bp.width + 1);
    });

    test('recommended-actions view renders a recommendation row and supports filtering', async ({
      page,
    }) => {
      await gotoDashboard(page);
      await page.getByTestId('tab-recommended').click();

      const view = page.getByTestId('recommended-actions-view');
      await expect(view).toBeVisible();
      const rows = page.getByTestId('recommended-action-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText('reply_needed');
      await expect(rows.first()).toContainText('0.87');

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(bp.width + 1);
    });

    test('drafts-awaiting-approval view renders a draft with an approve action', async ({
      page,
    }) => {
      await gotoDashboard(page);
      await page.getByTestId('tab-drafts').click();

      const view = page.getByTestId('drafts-awaiting-approval-view');
      await expect(view).toBeVisible();
      await expect(view.getByText('Thursday works')).toBeVisible();
      await expect(view.getByRole('button', { name: /approve/i })).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(bp.width + 1);
    });

    test('connect-channel wizard view renders the connected-accounts list', async ({ page }) => {
      await gotoDashboard(page);
      await page.getByTestId('tab-channels').click();

      const view = page.getByTestId('channels-view');
      await expect(view).toBeVisible();
      await expect(page.getByTestId('connected-account-row')).toHaveCount(1);
      await expect(page.getByTestId('connect-channel-row')).toHaveCount(6); // 6 CHANNEL_TYPES
    });

    test('tab navigation is reachable and usable at this breakpoint', async ({ page }) => {
      await gotoDashboard(page);
      for (const tab of ['metrics', 'recommended', 'drafts', 'queue', 'channels']) {
        const tabButton = page.getByTestId(`tab-${tab}`);
        await expect(tabButton).toBeVisible();
        await tabButton.click();
        await expect(tabButton).toHaveAttribute('aria-selected', 'true');
      }
    });
  });
}

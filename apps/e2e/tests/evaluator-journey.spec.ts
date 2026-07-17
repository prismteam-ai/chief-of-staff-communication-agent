import { expect, test } from '@playwright/test';

import {
  expectBasicAccessibility,
  expectNoCredentialLeakage,
  expectNoHorizontalOverflow,
} from './test-support.js';

test.describe('signed-out evaluator journey', () => {
  test('loads an honest executive dashboard with actionable metrics', async ({
    page,
  }) => {
    await page.goto('/overview');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('metric-volume')).toBeVisible();
    await expect(page.getByTestId('metric-pending')).toBeVisible();
    await expect(page.getByTestId('metric-answered')).toBeVisible();
    await expect(page.getByTestId('metric-overdue')).toBeVisible();
    await expect(page.getByTestId('channel-breakdown')).toContainText(
      /gmail|email/i,
    );
    await expect(page.getByTestId('channel-breakdown')).toContainText(/sms/i);
    await expect(page.getByTestId('sla-panel')).toContainText(
      /p(?:50|95)|response/i,
    );

    await page.goto('/connections');
    const modeLabels = await page
      .locator('[data-testid^="capability-mode-"]')
      .allTextContents();
    expect(modeLabels.length).toBeGreaterThanOrEqual(4);
    expect(modeLabels.map((label) => label.trim().toLowerCase())).toEqual(
      expect.arrayContaining(['fixture', 'recorded evidence', 'blocked']),
    );
    for (const label of modeLabels) {
      expect(label.trim().toLowerCase()).toMatch(
        /^(?:live|recorded evidence|fixture|blocked|sandbox|degraded)$/u,
      );
    }

    await expect(page.getByText(/sign in|log in|authenticate/i)).toHaveCount(0);
    await expectBasicAccessibility(page);
    await expectNoCredentialLeakage(page);
  });

  test('filters the unified inbox and opens complete thread context', async ({
    page,
  }) => {
    await page.goto('/inbox');
    const filter = page.getByTestId('inbox-filter');
    await expect(filter).toBeVisible();
    await expect(
      page.locator('[data-testid^="inbox-row-"]').first(),
    ).toBeVisible();
    await filter.selectOption('overdue');

    const visibleRows = page.locator('[data-testid^="inbox-row-"]:visible');
    expect(await visibleRows.count()).toBeGreaterThan(0);
    for (const row of await visibleRows.all()) {
      await expect(row).toContainText(/overdue/i);
    }

    await page.goto('/inbox/thread-q3-launch');
    await expect(page.getByTestId('thread-detail')).toContainText(
      /email|sms|whatsapp/i,
    );
    await expect(page.getByTestId('thread-detail')).toContainText(
      /Jordan Lee|Taylor Reed/i,
    );
    await expect(page.locator('[data-testid^="attachment-"]')).not.toHaveCount(
      0,
    );
    await expect(page.getByTestId('thread-detail')).toContainText(
      /answered|pending|overdue/i,
    );
    await expect(
      page.getByRole('region', { name: 'Related Asana work' }),
    ).toContainText(/SEC-4821/i);
    await expectNoCredentialLeakage(page);
  });

  test('shows cited RAG, a focused context path, and a style-grounded draft', async ({
    page,
  }) => {
    await page.goto('/inbox/thread-q3-launch');

    await expect(page.getByTestId('recommendation')).toBeVisible();
    await expect(page.getByTestId('recommendation')).toContainText(
      /recommend|reply|action/i,
    );
    await expect(page.getByTestId('confidence')).toContainText(/confidence|%/i);
    const citations = page.locator('[data-testid^="citation-"]');
    expect(await citations.count()).toBeGreaterThanOrEqual(2);
    for (const citation of await citations.all()) {
      await expect(citation).not.toBeEmpty();
    }
    await page
      .getByRole('button', { name: 'Request additional context' })
      .click();
    await expect(page.getByTestId('context-request')).toContainText(
      /context|clarif|requested|missing/i,
    );
    await expect(
      page.getByRole('status').filter({ hasText: /focused context request/i }),
    ).toContainText(/focused context request/i);
    await expect(page.getByTestId('draft-editor')).toBeEditable();
    await expect(
      page.getByText(/style profile|concise|direct|tone/i).first(),
    ).toBeVisible();
  });

  test('requires revision and explicit approval before an effect-disabled receipt', async ({
    page,
  }) => {
    await page.goto('/inbox/thread-q3-launch');

    await expect(page.getByTestId('execution-receipt')).toBeHidden();
    await expect(
      page.getByRole('button', {
        name: /^(?:send|send now|execute|execute now)$/i,
      }),
    ).toHaveCount(0);

    const draft = page.getByTestId('draft-editor');
    const originalDraft = await draft.inputValue();
    const revisedDraft = `${originalDraft.trim()}\n\nI’ll post the final launch brief by 16:00 UTC.`;
    await draft.fill(revisedDraft);
    await page
      .getByRole('button', {
        name: /save revision|create revision|revise draft|revise for brevity/i,
      })
      .click();

    await expect(page.getByTestId('revision-diff')).toBeVisible();
    await expect(page.getByTestId('revision-diff')).toContainText(/17:00 UTC/i);
    await expect(page.getByTestId('execution-receipt')).toBeHidden();

    const approve = page.getByTestId('approve-action');
    await expect(approve).toBeEnabled();
    await approve.click();
    const confirmation = page.getByRole('button', {
      name: /confirm approval|approve exact revision/i,
    });
    if (await confirmation.isVisible()) await confirmation.click();

    await expect(page.getByTestId('execution-receipt')).toBeVisible();
    await expect(page.getByTestId('execution-receipt')).toContainText(
      /effect.?disabled/i,
    );
    await expect(page.getByTestId('execution-receipt')).toContainText(
      /no external|fixture|network/i,
    );
    await expect(page.getByTestId('asana-status')).toContainText(
      /prepared|effect.?disabled|fixture/i,
    );
    await expect(page.getByTestId('audit-timeline')).toContainText(/revision/i);
    await expect(page.getByTestId('audit-timeline')).toContainText(/approv/i);
    await expect(page.getByTestId('audit-timeline')).toContainText(
      /effect switch off|no external call/i,
    );
    await expectNoCredentialLeakage(page);
  });

  test('keeps approval unavailable when an edited draft has not become a revision', async ({
    page,
  }) => {
    await page.goto('/inbox/thread-q3-launch');
    const draft = page.getByTestId('draft-editor');
    await draft.fill(`${await draft.inputValue()} Uncommitted edit.`);

    await expect(page.getByTestId('approve-action')).toBeDisabled();
    await expect(page.getByTestId('execution-receipt')).toBeHidden();
  });

  test('exposes evaluator evidence and safe Cursor MCP connection instructions', async ({
    page,
  }) => {
    await page.goto('/evidence');

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      /evidence|evaluator/i,
    );
    await expect(page.getByTestId('mcp-instructions')).toContainText(/cursor/i);
    await expect(page.getByTestId('mcp-instructions')).toContainText(/mcp/i);
    await expect(page.getByTestId('mcp-instructions')).toContainText(
      /approval/i,
    );
    await expect(
      page.getByText(/effect.?disabled|fixture/i).first(),
    ).toBeVisible();
    await expectNoCredentialLeakage(page);
  });
});

test.describe('navigation, responsive behavior, and keyboard access', () => {
  for (const route of [
    '/overview',
    '/inbox',
    '/inbox/thread-q3-launch',
    '/approvals',
    '/connections',
    '/evidence',
  ]) {
    test(`supports direct load and reload for ${route}`, async ({ page }) => {
      const firstResponse = await page.goto(route);
      expect(firstResponse?.ok()).toBe(true);
      await expect(page.getByRole('main')).toBeVisible();

      const reloadResponse = await page.reload();
      expect(reloadResponse?.ok()).toBe(true);
      await expect(page.getByRole('main')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(route);
    });
  }

  test('is usable on a narrow mobile viewport without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/overview');
    await expectNoHorizontalOverflow(page);

    await page.goto('/inbox/thread-q3-launch');
    await expect(page.getByTestId('thread-detail')).toBeVisible();
    await expect(page.getByTestId('draft-editor')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('reaches and operates the inbox filter using only the keyboard', async ({
    page,
  }) => {
    await page.goto('/inbox');
    const filter = page.getByTestId('inbox-filter');

    await page.getByLabel('Search communications').focus();
    await page.keyboard.press('Tab');
    await expect(filter).toBeFocused();

    await page.keyboard.press('Home');
    await page.keyboard.press('o');
    await page.keyboard.press('Enter');
    await expect(filter).toHaveValue('overdue');
    await expectBasicAccessibility(page);
  });
});

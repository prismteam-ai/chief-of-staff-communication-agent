import { expect, test, type Page } from '@playwright/test';

import {
  expectBasicAccessibility,
  expectNoCredentialLeakage,
  expectNoHorizontalOverflow,
} from './test-support.js';

const hostedProjectionResponses: Readonly<Record<string, unknown>> = {
  'system.health': {
    service: 'chief-api',
    status: 'ok',
    timestamp: '2026-07-17T12:00:00.000Z',
    foundationOnly: false,
  },
  'dashboard.metrics': {
    totalCommunications: 2,
    pendingApprovalCount: 0,
    channelBreakdown: [{ channel: 'email', count: 2 }],
    snapshot: {
      schemaVersion: '1',
      window: '7d',
      measuredAt: '2026-07-17T12:00:00.000Z',
      pendingCount: 1,
      overdueCount: 1,
      answeredCount: 0,
      resolvedCount: 0,
      responseTimeP50Ms: 42_000,
      responseTimeP95Ms: 118_000,
      ingestionLagP95Ms: 24_000,
    },
  },
  'communications.list': {
    items: [
      {
        messageId: 'message-1',
        messageRevisionId: 'message-revision-1-1',
        revision: 1,
        threadId: 'thread-1',
        direction: 'inbound',
        status: 'overdue',
        senderDisplayName: 'Jordan Lee',
        recipientDisplayNames: ['Public evaluator'],
        subject: 'Friday launch decision',
        excerpt: 'Can we confirm the Friday launch and the owner for QA?',
        attachmentCount: 0,
        sourceTimestamp: '2026-07-17T10:52:00.000Z',
        productUrl: 'https://chief.example/communications/message-revision-1-1',
      },
      {
        messageId: 'message-2',
        messageRevisionId: 'message-revision-2-1',
        revision: 1,
        threadId: 'thread-2',
        direction: 'inbound',
        status: 'pending',
        senderDisplayName: 'Priya Shah',
        recipientDisplayNames: ['Public evaluator'],
        subject: 'Board update numbers',
        excerpt:
          'Please send the approved pipeline numbers for the board note.',
        attachmentCount: 0,
        sourceTimestamp: '2026-07-17T11:06:00.000Z',
        productUrl: 'https://chief.example/communications/message-revision-2-1',
      },
    ],
  },
  'connectors.status': {
    connectors: [],
  },
  'approvals.status': {
    proposalId: 'proposal-route-approved',
    status: 'approved',
    approvalUrl: 'https://chief.example/approvals/proposal-route-approved',
    updatedAt: '2026-07-17T12:02:00.000Z',
  },
  'execution.status': {
    proposalId: 'proposal-route-approved',
    runtimeMode: 'fixture',
    storageMode: 'durable',
    effectPolicy: 'effect_disabled',
    externalEffect: false,
    status: 'effect_disabled',
    receipt: {
      kind: 'effect_disabled',
      operationId: 'operation-route-approved',
      artifactHash: 'c'.repeat(64),
      stableIdempotencyKey: 'route-approved-once',
      observedAt: '2026-07-17T12:02:00.000Z',
    },
  },
};

async function mockDurableHostedProjection(page: Page): Promise<void> {
  await page.route('**/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const marker = '/trpc/';
    const procedurePath = decodeURIComponent(
      url.pathname.slice(url.pathname.indexOf(marker) + marker.length),
    );
    const procedures = procedurePath.split(',');
    const results = procedures.map((procedure) => {
      const value = hostedProjectionResponses[procedure];
      if (value === undefined) {
        throw new Error(`Unexpected mocked tRPC procedure: ${procedure}`);
      }
      return { result: { data: value } };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(results),
    });
  });
}

async function expectModeSpecificReadOnlyBody(page: Page): Promise<void> {
  const persistedCopy = page.getByText(/persisted body is read-only/i);
  const fallbackCopy = page.getByText(/read-only fallback body/i);
  const durableHosted = await page
    .getByText('Durable hosted evaluator data.')
    .isVisible();
  if (durableHosted) {
    await expect(persistedCopy).toBeVisible();
    await expect(fallbackCopy).toHaveCount(0);
  } else {
    await expect(fallbackCopy).toBeVisible();
    await expect(persistedCopy).toHaveCount(0);
  }
}

test.describe('signed-out evaluator journey', () => {
  test('renders the exact hosted projection counts without implying an effect', async ({
    page,
  }) => {
    await mockDurableHostedProjection(page);
    await page.goto('/overview');

    await expect(
      page.getByText('Durable hosted evaluator data.'),
    ).toBeVisible();
    await expect(
      page.getByTestId('metric-volume').locator('strong'),
    ).toHaveText('2');
    await expect(page.getByTestId('metric-pending')).toContainText(
      '0 awaiting approval',
    );
    await expect(page.getByTestId('nav-pending-approval-count')).toHaveText(
      '0',
    );
    await expect(page.getByRole('link', { name: 'View all 2' })).toBeVisible();
    await expect(page.getByTestId('activity-source-label')).toContainText(
      /demonstration only.*hosted fixed-scope email projection/i,
    );

    await page.goto('/inbox');
    await expect(
      page.getByText('Fixed-scope email communications'),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      /two fixed-scope email seed communications/i,
    );

    await page.goto('/evidence');
    await expect(page.getByRole('main')).toContainText(
      /fixed-scope email communication queue/i,
    );
    await expect(page.getByRole('main')).toContainText(/demonstration-only/i);
    await expect(page.getByRole('main')).not.toContainText(/cross-channel/i);

    await page.goto('/approvals');
    await expect(page.getByTestId('approval-pending-count')).toHaveText(
      '0 pending',
    );
    await expect(
      page.getByRole('heading', { name: 'Prepared effect-disabled examples' }),
    ).toBeVisible();
    await expect(page.getByText(/1 side effect/i)).toHaveCount(0);
    await expect(
      page.getByText(/prepared outbox · effect disabled/i),
    ).toBeVisible();
    await expect(page.getByText(/demonstration only/i)).toHaveCount(3);
    await expectNoCredentialLeakage(page);
  });

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
    await expect(page.getByTestId('hosted-seed-fixture-count')).toHaveText(
      '1 fixed-scope hosted connector card',
    );
    await expect(page.getByTestId('hosted-seed-recorded-count')).toHaveText(
      '0 hosted evidence cards',
    );
    await expect(page.getByTestId('hosted-seed-blocked-count')).toHaveText(
      '0 hosted connector cards',
    );
    await expect(
      page.getByTestId('hosted-connector-seed-summary'),
    ).toContainText(/mode legend defines other states/i);
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

  test('loads and reloads an exact durable approval URL read-only', async ({
    page,
  }) => {
    await mockDurableHostedProjection(page);
    await page.goto('/approvals/proposal-route-approved');

    await expect(
      page.getByRole('heading', { name: 'Approval completed safely' }),
    ).toBeVisible();
    await expect(page.getByTestId('approval-route-status')).toContainText(
      'proposal-route-approved',
    );
    await expect(page.getByTestId('execution-receipt')).toContainText(
      'operation-route-approved',
    );
    await expect(page.getByTestId('execution-receipt')).toContainText(
      /durable effect-disabled receipt/i,
    );
    await expect(
      page.getByRole('button', { name: /approve|send|dispatch/i }),
    ).toHaveCount(0);

    const reloadResponse = await page.reload();
    expect(reloadResponse?.ok()).toBe(true);
    await expect(
      page.getByRole('heading', { name: 'Approval completed safely' }),
    ).toBeVisible();
    await expect(page.getByTestId('execution-receipt')).toContainText(
      'operation-route-approved',
    );
    expect(new URL(page.url()).pathname).toBe(
      '/approvals/proposal-route-approved',
    );
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
    await expect(page.getByTestId('draft-editor')).toHaveAttribute('readonly');
    await expectModeSpecificReadOnlyBody(page);
    await expect(
      page.getByText(/style profile|concise|direct|tone/i).first(),
    ).toBeVisible();
  });

  test('creates or reuses a bounded concise revision without granting local fallback approval', async ({
    page,
  }) => {
    await page.goto('/inbox/thread-q3-launch');

    await expect(
      page.getByRole('button', {
        name: /^(?:send|send now|execute|execute now)$/i,
      }),
    ).toHaveCount(0);

    const draft = page.getByTestId('draft-editor');
    const originalDraft = await draft.inputValue();
    await expect(draft).toHaveAttribute('readonly');
    await expectModeSpecificReadOnlyBody(page);
    const createRevision = page.getByRole('button', {
      name: 'Create concise revision',
    });
    const completedRevision = page.getByRole('button', {
      name: 'Concise revision created',
    });
    await expect(createRevision.or(completedRevision)).toBeVisible();

    if (await createRevision.isVisible()) {
      await expect(page.getByTestId('execution-receipt')).toBeHidden();
      await createRevision.click();

      await expect(page.getByTestId('revision-diff')).toBeVisible();
      await expect(page.getByTestId('revision-diff')).toContainText(
        /revision/i,
      );
      const revisedDraft = await draft.inputValue();
      expect(revisedDraft).not.toBe(originalDraft);
      expect(revisedDraft.length).toBeLessThan(originalDraft.length);
      await expect(page.getByTestId('execution-receipt')).toBeHidden();

      const approve = page.getByTestId('approve-action');
      const durableHosted = await page
        .getByText('Durable hosted evaluator data.')
        .isVisible();
      if (durableHosted) {
        await expect(approve).toBeEnabled();
        await approve.click();
      } else {
        await expect(approve).toBeDisabled();
        await expect(
          page.getByText(/not persisted and cannot be approved/i),
        ).toBeVisible();
      }
    } else {
      await expect(completedRevision).toBeDisabled();
      await expect(
        page.locator('label[for="hosted-draft-editor"]'),
      ).toContainText(/revision 2/i);
    }

    if (await page.getByText('Durable hosted evaluator data.').isVisible()) {
      await expect(page.getByTestId('execution-receipt')).toBeVisible();
      await expect(page.getByTestId('execution-receipt')).toContainText(
        /durable effect.?disabled/i,
      );
      await expect(page.getByTestId('audit-timeline')).toContainText(
        /receipt persisted|no external call/i,
      );
    }
    await expectNoCredentialLeakage(page);
  });

  test('keeps the draft read-only across pending and completed revision states', async ({
    page,
  }) => {
    await page.goto('/inbox/thread-q3-launch');
    const draft = page.getByTestId('draft-editor');

    await expect(draft).toHaveAttribute('readonly');
    const createRevision = page.getByRole('button', {
      name: 'Create concise revision',
    });
    const completedRevision = page.getByRole('button', {
      name: 'Concise revision created',
    });
    await expect(createRevision.or(completedRevision)).toBeVisible();
    if (await createRevision.isVisible()) {
      await expect(page.getByTestId('revision-diff')).toBeHidden();
      await expect(page.getByTestId('approve-action')).toBeDisabled();
      await expect(page.getByTestId('execution-receipt')).toBeHidden();
    } else {
      await expect(completedRevision).toBeDisabled();
      await expect(page.getByTestId('execution-receipt')).toContainText(
        /durable effect.?disabled/i,
      );
    }
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
      /prepare and approve through the server-authorized product browser or API/i,
    );
    await expect(page.getByTestId('mcp-instructions')).toContainText(
      /does not provide OAuth/i,
    );
    await expect(page.getByTestId('mcp-instructions')).not.toContainText(
      /authenticated/i,
    );
    await expect(page.getByTestId('mcp-instructions')).toContainText(
      /MCP can poll get_approval_status/i,
    );
    await expect(page.getByTestId('mcp-instructions')).not.toContainText(
      'submit_for_approval',
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

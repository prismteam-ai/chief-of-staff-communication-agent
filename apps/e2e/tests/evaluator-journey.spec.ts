import { expect, test, type Page } from '../auth-fixture.js';

import {
  expectBasicAccessibility,
  expectNoCredentialLeakage,
  expectNoHorizontalOverflow,
} from './test-support.js';

const hostedBaseUrlsConfigured = [
  process.env.CHIEF_BASE_URL,
  process.env.CHIEF_API_BASE_URL,
  process.env.CHIEF_MCP_BASE_URL,
].some((value) => value !== undefined && value.trim().length > 0);

const fixtureConnectorCapabilities = {
  read: true,
  send: false,
  webhook: false,
  poll: false,
  threads: true,
  attachments: true,
  deliveryFeedback: false,
  multipleAccounts: true,
  historicalBackfill: true,
  externalEffect: false,
  replyCorrelation: true,
  complaintFeedback: false,
  unsubscribeFeedback: false,
  optOutFeedback: false,
  reconsentFeedback: false,
  consentWindowEligibility: false,
} as const;

const fixtureConnectors = [
  ['gmail', 'account-gmail-fixture', 'brand-northstar'],
  [
    'microsoft_graph',
    'account-tenant-demo-northstar-microsoft_graph-01',
    'brand-harbor',
  ],
  ['sms', 'account-tenant-demo-northstar-sms-02', 'brand-northstar'],
  ['whatsapp', 'account-tenant-demo-northstar-whatsapp-03', 'brand-harbor'],
  ['x', 'account-tenant-demo-northstar-x-04', 'brand-northstar'],
  [
    'linkedin_archive',
    'account-tenant-demo-northstar-linkedin_archive-05',
    'brand-harbor',
  ],
  [
    'future_demo',
    'account-tenant-demo-northstar-future_demo-06',
    'brand-northstar',
  ],
].map(([channel, accountId, brandId]) => ({
  accountId,
  brandId,
  connectorId: channel === 'gmail' ? 'gmail' : `demo-${channel}`,
  displayLabel: `${channel?.replaceAll('_', ' ')} synthetic evaluator fixture`,
  provider: channel === 'microsoft_graph' ? 'microsoft' : channel,
  connectorKind: 'communication',
  channel,
  status: 'active',
  health: 'healthy',
  runtimeMode: channel === 'linkedin_archive' ? 'manual' : 'fixture',
  selectionState: 'selected',
  capabilities: fixtureConnectorCapabilities,
  lastSyncAt: '2026-07-17T09:00:00.000Z',
  productUrl: `https://chief.example/settings/connectors/${channel}`,
}));

const fixtureProjectionResponses: Readonly<Record<string, unknown>> = {
  'system.health': {
    service: 'chief-api',
    status: 'ok',
    timestamp: '2026-07-17T12:00:00.000Z',
    foundationOnly: false,
  },
  'dashboard.metrics': {
    totalCommunications: 1_120,
    pendingApprovalCount: 0,
    channelBreakdown: [
      { channel: 'gmail', count: 161 },
      { channel: 'microsoft_graph', count: 161 },
      { channel: 'sms', count: 161 },
      { channel: 'whatsapp', count: 161 },
      { channel: 'x', count: 161 },
      { channel: 'linkedin_archive', count: 161 },
      { channel: 'future_demo', count: 154 },
    ],
    snapshot: {
      schemaVersion: '1',
      window: '7d',
      measuredAt: '2026-07-17T12:00:00.000Z',
      pendingCount: 201,
      overdueCount: 201,
      answeredCount: 618,
      resolvedCount: 100,
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
        channel: 'gmail',
        accountId: 'account-gmail-fixture',
        brandId: 'brand-northstar',
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
        channel: 'gmail',
        accountId: 'account-gmail-fixture',
        brandId: 'brand-northstar',
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
    totalCount: 1_120,
    nextCursor: 'fixture-page-2',
  },
  'connectors.status': {
    connectors: fixtureConnectors,
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

async function mockFixtureProjection(page: Page): Promise<void> {
  if (hostedBaseUrlsConfigured)
    throw new Error(
      'FIXTURE_ROUTE_INTERCEPTION_FORBIDDEN_WHEN_HOSTED_URLS_ARE_CONFIGURED',
    );
  await page.route('**/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const marker = '/trpc/';
    const procedurePath = decodeURIComponent(
      url.pathname.slice(url.pathname.indexOf(marker) + marker.length),
    );
    const procedures = procedurePath.split(',');
    const results = procedures.map((procedure) => {
      const value = fixtureProjectionResponses[procedure];
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

/**
 * Threads the deterministic evaluator identity publishes as typed anchor
 * overlays. Everything else in the corpus is a non-anchor thread, which only
 * carries a grounded, cited recommendation because ingestion tags real
 * per-thread evidence. A non-anchor row on /recommended is therefore the only
 * assertion that proves the grounding rather than the two hand-authored
 * anchors.
 */
const anchorThreadIds: readonly string[] = [
  'thread-1',
  'thread-2',
  'thread-q3-launch',
  'thread-board-packet',
  'thread-tenant-demo-northstar-0000',
  'thread-tenant-demo-northstar-0007',
];

const recommendedActionInspectionLimit = 12;

const recommendedCorpusThreadCount = 40;

const recommendedCorpus = Array.from(
  { length: recommendedCorpusThreadCount },
  (_, index) => {
    const label = String(index).padStart(2, '0');
    return {
      messageId: `corpus-message-${label}`,
      messageRevisionId: `corpus-message-revision-${label}`,
      revision: 1,
      threadId: `corpus-thread-${label}`,
      direction: 'inbound',
      // Deliberately newer than both anchor overlays so the newest-first cap
      // selects non-anchor threads only.
      status: index % 2 === 0 ? 'overdue' : 'pending',
      channel: 'gmail',
      accountId: 'account-gmail-fixture',
      brandId: 'brand-northstar',
      senderDisplayName: 'Corpus Sender',
      recipientDisplayNames: ['Public evaluator'],
      subject: `Corpus actionable thread ${label}`,
      excerpt: 'Deterministic synthetic evaluator corpus message.',
      attachmentCount: 0,
      sourceTimestamp: new Date(
        Date.UTC(2026, 6, 17, 13, 0, 0) - index * 60_000,
      ).toISOString(),
      productUrl: `https://chief.example/communications/corpus-message-revision-${label}`,
    };
  },
);

const anchorActionableCommunications = (
  fixtureProjectionResponses['communications.list'] as {
    readonly items: readonly { readonly status: string }[];
  }
).items;

function buildMockedRecommendation(messageRevisionId: string): unknown {
  return {
    recommendation: {
      schemaVersion: '1',
      tenantId: 'tenant-demo-northstar',
      recommendationId: `recommendation-${messageRevisionId}`,
      revision: 1,
      sourceMessageRevisionId: messageRevisionId,
      actionType: 'reply',
      structuredParameters: {},
      confidence: 0.82,
      urgency: 'normal',
      reasonSummary:
        'Reply using the retrieved evidence bound to this exact thread.',
      citations: [
        {
          citationId: `citation-${messageRevisionId}`,
          sourceId: `source-${messageRevisionId}`,
          sourceVersion: '1',
          chunkId: `chunk-${messageRevisionId}`,
          label: 'Communication context',
          contentHash: 'd'.repeat(64),
          hydratedUnderAuthorizationEpoch: 1,
        },
      ],
      missingFacts: [],
      status: 'current',
      reproducibility: {
        schemaVersion: '1',
        selectedProfileManifestHash: 'e'.repeat(64),
        routeId: 'action-context',
        modelProfileId: 'fixture-generation',
        gatewayVersion: '1',
        promptHash: 'a'.repeat(64),
        policyHash: 'b'.repeat(64),
        schemaHash: 'c'.repeat(64),
        retrievalQueryHash: '0'.repeat(64),
        retrievalSnapshotManifestHash: '1'.repeat(64),
        requestHash: '2'.repeat(64),
        inputTokens: 128,
        outputTokens: 64,
        latencyMs: 12,
        outcome: 'valid',
      },
      createdAt: '2026-07-17T13:05:00.000Z',
    },
  };
}

interface MockedTrpcCall {
  readonly procedure: string;
  readonly input: unknown;
}

function readTrpcCalls(
  method: string,
  url: URL,
  postData: string | null,
): readonly MockedTrpcCall[] {
  const marker = '/trpc/';
  const procedures = decodeURIComponent(
    url.pathname.slice(url.pathname.indexOf(marker) + marker.length),
  ).split(',');
  const batched = url.searchParams.get('batch') === '1';
  const raw =
    method === 'GET' ? url.searchParams.get('input') : (postData ?? null);
  const parsed =
    raw === null || raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
  return procedures.map((procedure, index) => ({
    procedure,
    input: batched
      ? (parsed as Record<string, unknown> | undefined)?.[String(index)]
      : parsed,
  }));
}

/**
 * Extends the shared fixture projection with a corpus large enough to exceed
 * the bounded recommendation fan-out, plus per-message `agent.recommend`
 * responses. Never used when hosted URLs are configured.
 */
async function mockRecommendedProjection(page: Page): Promise<void> {
  if (hostedBaseUrlsConfigured)
    throw new Error(
      'FIXTURE_ROUTE_INTERCEPTION_FORBIDDEN_WHEN_HOSTED_URLS_ARE_CONFIGURED',
    );
  await page.route('**/trpc/**', async (route) => {
    const request = route.request();
    const calls = readTrpcCalls(
      request.method(),
      new URL(request.url()),
      request.postData(),
    );
    const results = calls.map(({ procedure, input }) => {
      if (procedure === 'agent.recommend') {
        const { messageRevisionId } = input as {
          readonly messageRevisionId: string;
        };
        return {
          result: { data: buildMockedRecommendation(messageRevisionId) },
        };
      }
      if (procedure === 'communications.list') {
        const status = (input as { readonly status?: string } | undefined)
          ?.status;
        if (status === 'pending' || status === 'overdue') {
          return {
            result: {
              data: {
                items: [
                  ...recommendedCorpus,
                  ...anchorActionableCommunications,
                ].filter((item) => item.status === status),
                totalCount:
                  recommendedCorpusThreadCount +
                  anchorActionableCommunications.length,
              },
            },
          };
        }
      }
      const value = fixtureProjectionResponses[procedure];
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

async function expectNonAnchorCitedRecommendation(page: Page): Promise<void> {
  const rows = page.getByTestId('recommended-action-row');
  await expect(rows.first()).toBeVisible();
  const nonAnchorCitedTexts: string[] = [];
  for (const row of await rows.all()) {
    const href = (await row.getAttribute('href')) ?? '';
    const threadId = href.slice(href.lastIndexOf('/') + 1);
    if (anchorThreadIds.includes(threadId)) continue;
    const text = (await row.textContent()) ?? '';
    if (/\b[1-9]\d* citations\b/u.test(text)) nonAnchorCitedTexts.push(text);
  }
  expect(
    nonAnchorCitedTexts.length,
    'at least one non-anchor thread must render a server recommendation with citations',
  ).toBeGreaterThan(0);
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

test.describe('authenticated evaluator journey', () => {
  test('renders exact V2 fixture projection without external-effect claims', async ({
    page,
  }) => {
    test.skip(
      hostedBaseUrlsConfigured,
      'Fixture route interception is excluded from hosted acceptance.',
    );
    await mockFixtureProjection(page);
    await page.goto('/overview');

    await expect(
      page.getByText('Durable hosted evaluator data.'),
    ).toBeVisible();
    await expect(
      page.getByTestId('metric-volume').locator('strong'),
    ).toHaveText('1,120');
    await expect(page.getByTestId('metric-pending')).toContainText(
      '0 awaiting approval',
    );
    await expect(page.getByTestId('nav-pending-approval-count')).toHaveText(
      '0',
    );
    await expect(
      page.getByRole('link', { name: 'View all 1,120' }),
    ).toBeVisible();
    await expect(page.getByTestId('activity-source-label')).toContainText(
      /demonstration only.*hosted multichannel corpus/i,
    );

    await page.goto('/inbox');
    await expect(
      page.getByText('Server-authoritative multichannel corpus'),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      /complete deterministic 1,120-message corpus across seven channels/i,
    );
    await expect(page.getByRole('main')).toContainText(
      /showing 2 of 1,120 matching communications/i,
    );
    await expect(
      page.getByTestId('inbox-channel-filter').locator('option'),
    ).toHaveCount(8);

    await page.goto('/connections');
    await expect(page.getByTestId('connector-card')).toHaveCount(7);
    await expect(page.getByTestId('hosted-seed-fixture-count')).toHaveText(
      '7 hosted connector cards',
    );

    await page.goto('/evidence');
    await expect(page.getByRole('main')).toContainText(
      /1,120-message corpus across seven hosted synthetic channels/i,
    );
    await expect(page.getByRole('main')).toContainText(/demonstration-only/i);

    await page.goto('/approvals');
    await expect(page.getByTestId('approval-pending-count')).toContainText(
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

    const adversarialSessionToken = [
      `eyJ${'a'.repeat(12)}`,
      'a'.repeat(16),
      'b'.repeat(16),
    ].join('.');
    await page.context().addCookies([
      {
        name: 'adversarial_session',
        value: adversarialSessionToken,
        url: page.url(),
      },
    ]);
    await page.evaluate((token) => {
      const browser = globalThis as unknown as {
        readonly document: {
          readonly body: {
            readonly dataset: Record<string, string | undefined>;
          };
        };
      };
      browser.document.body.dataset.adversarialCredential = `Bearer ${token}`;
    }, adversarialSessionToken);
    let redactedFailure = '';
    try {
      await expectNoCredentialLeakage(page);
    } catch (error) {
      redactedFailure = error instanceof Error ? error.message : String(error);
    }
    expect(redactedFailure.length).toBeGreaterThan(0);
    expect(redactedFailure).toContain(
      'authorization credential in document markup',
    );
    expect(
      redactedFailure.includes(adversarialSessionToken),
      'credential diagnostics must redact secret values',
    ).toBe(false);
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        readonly document: {
          readonly body: {
            readonly dataset: Record<string, string | undefined>;
          };
        };
      };
      delete browser.document.body.dataset.adversarialCredential;
    });
    await page.context().clearCookies({ name: 'adversarial_session' });
    await expectNoCredentialLeakage(page);
  });

  test('loads an honest executive dashboard with actionable metrics', async ({
    page,
  }) => {
    if (!hostedBaseUrlsConfigured) await mockFixtureProjection(page);
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
    await expect(page.getByTestId('connector-card')).toHaveCount(7);
    await expect(page.getByTestId('hosted-seed-fixture-count')).toHaveText(
      '7 hosted connector cards',
    );
    await expect(page.getByTestId('hosted-seed-recorded-count')).toHaveText(
      '1 hosted evidence card',
    );
    await expect(page.getByTestId('hosted-seed-blocked-count')).toHaveText(
      '0 hosted connector cards',
    );
    await expect(
      page.getByTestId('hosted-connector-seed-summary'),
    ).toContainText(
      /seven account-scoped connector cards.*six fixture-mode cards and one manual\/recorded LinkedIn archive card/i,
    );
    const modeLabels = await page
      .locator('[data-testid^="capability-mode-"]')
      .allTextContents();
    expect(modeLabels.length).toBe(12);
    expect(modeLabels.map((label) => label.trim().toLowerCase())).toEqual(
      expect.arrayContaining(['fixture', 'recorded evidence', 'blocked']),
    );
    for (const label of modeLabels) {
      expect(label.trim().toLowerCase()).toMatch(
        /^(?:live|recorded evidence|fixture|blocked|sandbox|degraded)$/u,
      );
    }

    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expectBasicAccessibility(page);
    await expectNoCredentialLeakage(page);
  });

  test('loads and reloads an exact durable approval URL read-only', async ({
    page,
  }) => {
    test.skip(
      hostedBaseUrlsConfigured,
      'Fixture route interception is excluded from hosted acceptance.',
    );
    await mockFixtureProjection(page);
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

  test('forbids fixture route interception whenever hosted URLs are configured', async ({
    page,
  }) => {
    test.skip(
      !hostedBaseUrlsConfigured,
      'The guard is exercised by the strict hosted configuration.',
    );
    await expect(mockFixtureProjection(page)).rejects.toThrow(
      'FIXTURE_ROUTE_INTERCEPTION_FORBIDDEN_WHEN_HOSTED_URLS_ARE_CONFIGURED',
    );
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
    const durableHosted = await page
      .getByText('Durable hosted evaluator data.')
      .isVisible();
    const relatedAsana = page.getByRole('region', {
      name: 'Related Asana work',
    });
    if (durableHosted) {
      await expect(relatedAsana).toHaveCount(0);
    } else {
      await expect(relatedAsana).toContainText(/DEMO-4821/i);
    }
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
    const durableHosted = await page
      .getByText('Durable hosted evaluator data.')
      .isVisible();
    expect(await citations.count()).toBeGreaterThanOrEqual(
      durableHosted ? 1 : 2,
    );
    for (const citation of await citations.all()) {
      await expect(citation).not.toBeEmpty();
      if (durableHosted) {
        await expect(citation).not.toContainText(/asana|SEC-4821/i);
        expect(await citation.getAttribute('data-testid')).not.toMatch(
          /asana|SEC-4821/i,
        );
      }
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
      /short-lived bearer access token/i,
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

  test('renders cited non-anchor rows on the recommended actions view', async ({
    page,
  }) => {
    if (!hostedBaseUrlsConfigured) await mockRecommendedProjection(page);
    await page.goto('/recommended');

    await expect(page.getByTestId('recommended-actions-page')).toBeVisible();
    await expect(page.getByTestId('recommendation-scope')).toBeVisible();
    await expectNonAnchorCitedRecommendation(page);
    await expect(
      page.getByRole('button', { name: /approve|send|dispatch/i }),
    ).toHaveCount(0);
    await expectNoCredentialLeakage(page);
  });

  test('bounds the recommendation fan-out and discloses uninspected threads', async ({
    page,
  }) => {
    test.skip(
      hostedBaseUrlsConfigured,
      'Fixture route interception is excluded from hosted acceptance.',
    );
    await mockRecommendedProjection(page);
    let recommendCallCount = 0;
    page.on('request', (request) => {
      recommendCallCount += new URL(request.url()).pathname
        .split(',')
        .filter((part) => part.endsWith('agent.recommend')).length;
    });

    await page.goto('/recommended');

    await expect(page.getByTestId('recommendation-scope')).toContainText(
      /showing 12 server recommendations from the newest 12 of 42 unique actionable threads/i,
    );
    await expect(page.getByTestId('recommendation-scope')).toContainText(
      /remaining 30 actionable threads were deliberately not inspected/i,
    );
    await expect(page.getByTestId('recommended-action-row')).toHaveCount(
      recommendedActionInspectionLimit,
    );
    await expect(page.getByTestId('recommendation-progress')).toHaveCount(0);
    await expectNonAnchorCitedRecommendation(page);
    // The bounded fan-out is the point: corpus size must not drive the number
    // of `agent.recommend` mutations this read-only view issues.
    expect(recommendCallCount).toBe(recommendedActionInspectionLimit);
  });
});

test.describe('navigation, responsive behavior, and keyboard access', () => {
  for (const route of [
    '/overview',
    '/inbox',
    '/inbox/thread-q3-launch',
    '/recommended',
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

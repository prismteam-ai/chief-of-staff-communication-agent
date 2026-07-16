import type { Page } from '@playwright/test';

/**
 * Deterministic fixture data + a `page.route` mock for the tRPC HTTP contract (Task 8 design
 * tests). Design tests must render the SAME three views the live dashboard ships with — metrics,
 * recommended actions, drafts-awaiting-approval — without depending on AWS, so every
 * `metrics.*`/`communications.*`/`accounts.*` GET/POST is intercepted here and answered with fixed
 * fixture data matching the real tRPC envelope shape (`{result:{data:...}}`) `trpc-client.ts`
 * expects.
 */

const FIXTURE_ACCOUNT_ID = 'acct-gmail-demoalex775';
const FIXTURE_USER_ID = 'demo-alex';

export const FIXTURE_METRICS = {
  totalVolume: 12,
  statusBreakdown: {
    ingested: 2,
    recommended: 1,
    drafted: 3,
    awaiting_approval: 1,
    approved: 0,
    sent: 0,
    answered: 4,
    edited: 0,
    rejected: 0,
    dismissed: 1,
    needs_context: 0,
    awaiting_reprocess: 0,
  },
  channelBreakdown: { gmail: 10, sms: 2 },
  overdueCount: 2,
  pendingApprovalsCount: 4,
  handledCount: 5,
  responseTime: {
    sampleCount: 4,
    averageSeconds: 187,
    medianSeconds: 150,
    underFiveMinutesCount: 3,
  },
};

const RECOMMENDATION_FIXTURE = {
  commId: 'gmail#fixture-1',
  accountId: FIXTURE_ACCOUNT_ID,
  actionType: 'reply_needed',
  confidence: 0.87,
  rationale: 'The sender is asking a direct scheduling question that needs a reply.',
};

export const FIXTURE_RECOMMENDED = [
  {
    commId: 'gmail#fixture-1',
    accountId: FIXTURE_ACCOUNT_ID,
    channelType: 'gmail',
    status: 'drafted',
    threadKey: 'thread-1',
    participants: [
      { id: 'demoalex775@gmail.com', role: 'from' },
      { id: 'renee@example.com', displayName: 'Renee Castellano', role: 'to' },
    ],
    ts: '2026-07-16T12:00:00.000Z',
    body: 'Can we push our sync to Thursday?',
    recommendation: RECOMMENDATION_FIXTURE,
    draft: {
      commId: 'gmail#fixture-1',
      accountId: FIXTURE_ACCOUNT_ID,
      body: 'Thursday works — sending an invite now.',
      confidence: 0.87,
    },
  },
];

export const FIXTURE_DRAFTS = FIXTURE_RECOMMENDED;

export const FIXTURE_ACCOUNTS = [
  {
    accountId: FIXTURE_ACCOUNT_ID,
    channelType: 'gmail',
    displayName: 'demoalex775@gmail.com',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
];

function envelope(data: unknown) {
  return { result: { data } };
}

/** Installs mock routes for every tRPC procedure the dashboard calls, keyed by procedure name in
 * the request URL/path — works for both GET (`?input=`) queries and POST mutations. */
export async function mockDashboardApi(page: Page): Promise<void> {
  await page.route('**/metrics.getDashboardMetrics*', async (route) => {
    await route.fulfill({ json: envelope(FIXTURE_METRICS) });
  });
  await page.route('**/metrics.listRecommendedActions*', async (route) => {
    await route.fulfill({ json: envelope(FIXTURE_RECOMMENDED) });
  });
  await page.route('**/metrics.listDraftsAwaitingApproval*', async (route) => {
    await route.fulfill({ json: envelope(FIXTURE_DRAFTS) });
  });
  await page.route('**/communications.listCommunications*', async (route) => {
    await route.fulfill({ json: envelope(FIXTURE_RECOMMENDED) });
  });
  await page.route('**/accounts.listConnectedAccounts*', async (route) => {
    await route.fulfill({ json: envelope(FIXTURE_ACCOUNTS) });
  });
}

export const FIXTURE_API_URL = 'https://mock-api.test';

/** Loads the dashboard with mocked routes installed and the API URL preset via localStorage,
 * skipping the "type in an API URL" step every design test would otherwise repeat. */
export async function gotoDashboard(page: Page): Promise<void> {
  await mockDashboardApi(page);
  await page.addInitScript(
    (init: { apiUrl: string; accountId: string; userId: string }) => {
      window.localStorage.setItem('cos.apiUrl', init.apiUrl);
      window.localStorage.setItem('cos.accountId', init.accountId);
      window.localStorage.setItem('cos.userId', init.userId);
    },
    { apiUrl: FIXTURE_API_URL, accountId: FIXTURE_ACCOUNT_ID, userId: FIXTURE_USER_ID },
  );
  await page.goto('/');
}

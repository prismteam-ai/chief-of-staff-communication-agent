import { expect, test, type Page } from '../auth-fixture.js';

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);

  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location();
      const expectedLocalFallbackProbe =
        process.env.CHIEF_BASE_URL === undefined &&
        location.url.startsWith('http://127.0.0.1:65534/trpc/') &&
        message.text().includes('net::ERR_CONNECTION_REFUSED');
      if (expectedLocalFallbackProbe) return;
      const source =
        location.url.length > 0
          ? ` (${location.url}:${location.lineNumber})`
          : '';
      errors.push(`console: ${message.text()}${source}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
});

test.afterEach(({ page }) => {
  expect(browserErrors.get(page) ?? [], 'browser errors').toEqual([]);
});

const secretPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['authorization credential', /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=-]{12,}/u],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u],
  [
    'credential query parameter',
    /[?&](?:access_token|refresh_token|id_token|client_secret|api[_-]?key)=[^&#\s]+/iu,
  ],
];

interface InspectedValue {
  readonly source: string;
  readonly value: string;
}

function credentialLeakLocations(
  values: readonly InspectedValue[],
): readonly string[] {
  const locations: string[] = [];
  for (const { source, value } of values) {
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(value)) locations.push(`${label} in ${source}`);
    }
  }
  return locations;
}

export async function expectNoCredentialLeakage(page: Page): Promise<void> {
  const markup = await page.content();
  const storageValues = await page.evaluate<{
    readonly localStorage: readonly string[];
    readonly sessionStorage: readonly string[];
  }>(
    '({ localStorage: Object.values(localStorage), sessionStorage: Object.values(sessionStorage) })',
  );
  const cookies = await page.context().cookies();
  const navigableUrls: string[] = [];
  const links = page.locator('a[href]');
  for (let index = 0; index < (await links.count()); index += 1) {
    const href = await links.nth(index).getAttribute('href');
    if (href !== null) navigableUrls.push(href);
  }
  const forms = page.locator('form[action]');
  for (let index = 0; index < (await forms.count()); index += 1) {
    const action = await forms.nth(index).getAttribute('action');
    if (action !== null) navigableUrls.push(action);
  }
  const resourceUrls: string[] = [];
  const resources = page.locator('script[src], link[href], img[src]');
  for (let index = 0; index < (await resources.count()); index += 1) {
    const resource = resources.nth(index);
    const url =
      (await resource.getAttribute('src')) ??
      (await resource.getAttribute('href'));
    if (url !== null) resourceUrls.push(url);
  }

  const inspected: InspectedValue[] = [
    { source: 'page URL', value: page.url() },
    { source: 'document markup', value: markup },
    ...storageValues.localStorage.map((value, index) => ({
      source: `localStorage value ${index + 1}`,
      value,
    })),
    ...storageValues.sessionStorage.map((value, index) => ({
      source: `sessionStorage value ${index + 1}`,
      value,
    })),
    ...navigableUrls.map((value, index) => ({
      source: `navigable URL ${index + 1}`,
      value,
    })),
    ...resourceUrls.map((value, index) => ({
      source: `resource URL ${index + 1}`,
      value,
    })),
  ];
  const violations = [...credentialLeakLocations(inspected)];

  // Cookie values are intentionally never inspected by a matcher or included
  // in diagnostics. The browser session token belongs in the HttpOnly jar; the
  // observable security contract here is its metadata, not its opaque value.
  for (const cookie of cookies) {
    if (cookie.name !== '__Host-chief_session') continue;
    if (!cookie.httpOnly) violations.push('session cookie is not HttpOnly');
    if (!cookie.secure) violations.push('session cookie is not Secure');
    if (cookie.sameSite !== 'Strict') {
      violations.push('session cookie SameSite policy is not Strict');
    }
    if (cookie.path !== '/') violations.push('session cookie path is not root');
  }

  expect(
    violations,
    'credential leakage locations (secret values redacted)',
  ).toEqual([]);
}

export async function expectBasicAccessibility(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', /\S+/u);
  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);

  const ids = new Set<string>();
  const duplicatedIds: string[] = [];
  const idElements = page.locator('[id]');
  for (let index = 0; index < (await idElements.count()); index += 1) {
    const id = await idElements.nth(index).getAttribute('id');
    if (id === null) continue;
    if (ids.has(id)) duplicatedIds.push(id);
    ids.add(id);
  }
  expect(duplicatedIds, 'duplicate element IDs').toEqual([]);

  const images = page.locator('img');
  for (let index = 0; index < (await images.count()); index += 1) {
    await expect(images.nth(index)).toHaveAttribute('alt');
  }

  const controls = page.locator(
    'button:visible, input:visible, select:visible, textarea:visible, a[href]:visible',
  );
  for (let index = 0; index < (await controls.count()); index += 1) {
    await expect(controls.nth(index)).toHaveAccessibleName(/\S/u);
  }
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate<{
    readonly clientWidth: number;
    readonly scrollWidth: number;
  }>(
    '({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })',
  );
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
}

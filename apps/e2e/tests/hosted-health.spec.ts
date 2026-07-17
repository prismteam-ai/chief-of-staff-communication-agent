import { expect, test } from '@playwright/test';

function endpointFromEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return undefined;

  const url = new URL(value);
  expect(url.username, `${name} must not include a username`).toBe('');
  expect(url.password, `${name} must not include a password`).toBe('');
  return url.toString().replace(/\/$/u, '');
}

test.describe('runtime health and static delivery', () => {
  test('serves the application shell and every referenced static asset', async ({
    page,
    request,
  }) => {
    const documentResponse = await page.goto('/overview');
    expect(documentResponse?.ok()).toBe(true);
    await expect(page.getByRole('main')).toBeVisible();

    const assetUrls: string[] = [];
    const scripts = page.locator('script[src]');
    for (let index = 0; index < (await scripts.count()); index += 1) {
      const source = await scripts.nth(index).getAttribute('src');
      if (source !== null)
        assetUrls.push(new URL(source, page.url()).toString());
    }
    const stylesheets = page.locator('link[rel="stylesheet"][href]');
    for (let index = 0; index < (await stylesheets.count()); index += 1) {
      const source = await stylesheets.nth(index).getAttribute('href');
      if (source !== null)
        assetUrls.push(new URL(source, page.url()).toString());
    }

    expect(assetUrls.length).toBeGreaterThan(0);
    for (const assetUrl of assetUrls) {
      const response = await request.get(assetUrl);
      expect(response.ok(), `${assetUrl} should be reachable`).toBe(true);
      expect(
        response.headers()['content-type'],
        `${assetUrl} should not resolve to the SPA HTML fallback`,
      ).not.toContain('text/html');
    }
  });

  test('reports typed API health when an API URL is supplied', async ({
    request,
  }) => {
    const apiBaseUrl = endpointFromEnvironment('CHIEF_API_BASE_URL');
    test.skip(
      apiBaseUrl === undefined,
      'Set CHIEF_API_BASE_URL to activate the deployed API health assertion.',
    );

    const input = encodeURIComponent(JSON.stringify({ '0': { json: null } }));
    const response = await request.get(
      `${apiBaseUrl}/trpc/system.health?batch=1&input=${input}`,
    );
    expect(response.ok()).toBe(true);
    await expect(response.text()).resolves.toContain('chief-api');
  });

  test('reports MCP health when an MCP URL is supplied', async ({
    request,
  }) => {
    const mcpBaseUrl =
      endpointFromEnvironment('CHIEF_MCP_BASE_URL') ??
      endpointFromEnvironment('CHIEF_API_BASE_URL');
    test.skip(
      mcpBaseUrl === undefined,
      'Set CHIEF_MCP_BASE_URL or CHIEF_API_BASE_URL to activate MCP health.',
    );

    const response = await request.get(`${mcpBaseUrl}/mcp/health`);
    expect(response.ok()).toBe(true);
    await expect(response.text()).resolves.toContain('chief-mcp');
  });
});

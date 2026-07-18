import { defineConfig, devices } from '@playwright/test';

function readPublicUrl(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return undefined;

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${name} must not contain credentials.`);
  }

  return url.toString().replace(/\/$/u, '');
}

const hostedBaseUrl = readPublicUrl('CHIEF_BASE_URL');
const localPort = process.env.CHIEF_E2E_PORT?.trim() || '43173';
const baseURL = hostedBaseUrl ?? `http://127.0.0.1:${localPort}`;
const isCi = process.env.CI === 'true';
const browserChannel = process.env.CHIEF_BROWSER_CHANNEL?.trim() || undefined;

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/hosted-durable.spec.ts'],
  outputDir: 'node_modules/.cache/playwright-results',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 1 : undefined,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: hostedBaseUrl === undefined ? 7_500 : 20_000 },
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    channel: browserChannel,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer:
    hostedBaseUrl === undefined
      ? {
          command: `pnpm --filter @chief/web exec vite --host 127.0.0.1 --port ${localPort} --strictPort`,
          env: {
            ...process.env,
            VITE_API_BASE_URL: readPublicUrl('CHIEF_API_BASE_URL') ?? '',
          },
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
        }
      : undefined,
});

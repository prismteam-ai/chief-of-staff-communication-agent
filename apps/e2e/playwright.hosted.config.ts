import { defineConfig, devices } from '@playwright/test';

import { readRequiredHostedEnvironment } from './hosted-environment.js';

const hosted = readRequiredHostedEnvironment();
const isCi = process.env.CI === 'true';
const browserChannel = process.env.CHIEF_BROWSER_CHANNEL?.trim() || undefined;

export default defineConfig({
  testDir: './tests',
  testMatch: [
    '**/evaluator-journey.spec.ts',
    '**/hosted-health.spec.ts',
    '**/hosted-durable.spec.ts',
  ],
  outputDir: 'node_modules/.cache/playwright-hosted-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: isCi ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: hosted.webBaseUrl,
    ...devices['Desktop Chrome'],
    channel: browserChannel,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: undefined,
});

import { defineConfig } from '@playwright/test';

import hostedConfig from './playwright.hosted.config.js';

export default defineConfig({
  ...hostedConfig,
  testMatch: ['**/hosted-durable.spec.ts'],
  outputDir: 'node_modules/.cache/playwright-hosted-demo',
  reporter: [['list']],
  use: {
    ...hostedConfig.use,
    screenshot: 'off',
    trace: 'off',
    video: {
      mode: 'on',
      size: { width: 1440, height: 900 },
    },
  },
});

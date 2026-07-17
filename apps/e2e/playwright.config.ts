import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  use: { baseURL: process.env.CHIEF_BASE_URL, trace: 'retain-on-failure' },
});

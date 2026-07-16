import { defineConfig, devices } from '@playwright/test';

/**
 * Responsive design-test harness (Task 8 brief constraint 6, `smeargle` -> `responsive-design-
 * tests` ADAPTED for this repo — see `test/design/README.md` for the full adaptation note: this
 * kit skill is normally driven by a Figma source with per-breakpoint mocked frames; there is no
 * Figma design for this dashboard, so the same breakpoint-config Playwright PATTERN is kept
 * (named viewport configs, one generic test body run per breakpoint) but the source of truth is
 * this repo's own `apps/web` React components rendered via `vite preview`, not a Figma export.
 *
 * Two projects:
 *  - `design`: mocked-API specs (`test/design/**`) at mobile/tablet/desktop breakpoints against a
 *    local `vite preview` server — deterministic, no AWS dependency, safe for CI.
 *  - `browser`: one real-device spec (`test/browser/**`) against the DEPLOYED Amplify URL with
 *    real data — not run by `just test` (needs live infra + `DASHBOARD_URL`); driven manually /
 *    as part of the Task 8 live-proof step.
 */
export default defineConfig({
  testDir: 'test',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  // Only the `design` project needs a local server — `browser` targets the deployed URL directly
  // via `test/browser/deployed-dashboard.spec.ts`'s own `DASHBOARD_URL` handling, so this
  // `webServer` block is scoped by `testDir`/base URL rather than started for both projects.
  webServer: {
    command: 'pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    {
      name: 'design',
      testDir: 'test/design',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
    },
    {
      name: 'browser',
      testDir: 'test/browser',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

# Evaluator browser and hosted acceptance

The Playwright suite proves the signed-out evaluator fixture journey and can run
unchanged against the local Vite application or the deployed CloudFront URL.
It never needs a provider credential and never performs an external effect.

## Coverage

- signed-out executive overview, volume/status/SLA metrics, and channel mix;
- exact `live`, `recorded`, `fixture`, `sandbox`, `degraded`, and `blocked`
  capability labels, including negatives against relabeling non-live evidence;
- status-filtered inbox, deep-linked thread chronology, participants,
  attachments, answered state, and Asana linkage;
- cited recommendation, confidence, focused context request, style profile,
  draft, immutable revision diff, and explicit approval;
- absence of direct send/execute controls, denial of approval for an uncommitted
  edit, and a visibly non-provider `effect_disabled` receipt after approval;
- Asana preparation state, append-only audit events, and response-time/SLA;
- evaluator evidence and Cursor/MCP connection guidance;
- clean direct navigation and refresh for every evaluator route;
- 375-pixel responsive behavior, tab-order operation, semantic landmarks, basic
  accessible names, image alternatives, unique IDs, and no horizontal overflow;
- zero browser console/page errors and scans for common access-key, private-key,
  authorization-header, JWT, and credential-query-string leakage;
- application shell, referenced static assets, typed API health, and MCP health.

The browser journey intentionally exercises the deterministic public fixture
tenant. It proves the real approval/outbox user contract while expecting only an
`effect_disabled` receipt. It does not claim a provider accepted or delivered a
message, and it does not replace the separately gated controlled-recipient live
acceptance evidence.

## Prerequisites

- Node `22.18.0` and pnpm `10.33.0`;
- workspace dependencies already installed;
- the Playwright Chromium browser already present in the execution environment.

The suite does not install packages or browsers and does not mutate a manifest
or lockfile.

## Local run

From the repository root, place the pinned Node directory first on `PATH` and
run the E2E workspace. Playwright starts Vite on `127.0.0.1:4173` when
`CHIEF_BASE_URL` is absent.

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/e2e typecheck
pnpm --filter @chief/e2e lint
pnpm --filter @chief/e2e build
pnpm --filter @chief/e2e test
```

Override the local port with `CHIEF_E2E_PORT`. To point the locally served UI at
an API, set `CHIEF_API_BASE_URL`; the value is passed to Vite as
`VITE_API_BASE_URL`. If the pinned Playwright Chromium bundle is unavailable but
a reviewed system Chrome/Edge is present, set `CHIEF_BROWSER_CHANNEL` to
`chrome` or `msedge`; CI should normally use its pinned Playwright browser.

## Deployed run

All endpoint values are public origins, not credentials. URLs containing a
username or password are rejected.

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
$env:CHIEF_BASE_URL = 'https://<cloudfront-host>'
$env:CHIEF_API_BASE_URL = 'https://<api-host>'
$env:CHIEF_MCP_BASE_URL = 'https://<mcp-or-api-host>' # optional when shared with API
pnpm --filter @chief/e2e test
```

`CHIEF_BASE_URL` disables the local web server. API health checks
`/trpc/system.health`; MCP health checks `/mcp/health`. API/MCP tests are
reported as skipped when their public origin is not supplied, so a local UI run
does not invent deployment evidence. A final hosted acceptance run must supply
both origins (or one shared API/MCP origin) and must finish with no skipped
health assertion.

Artifacts for failures (trace, screenshot, and video) stay under
`apps/e2e/node_modules/.cache/playwright-results`; they are ignored workspace
output and can contain rendered fixture content. Do not publish them without the
normal evidence/privacy review.

## Failure interpretation

- a deep-link response containing HTML but not the expected application main
  surface indicates CloudFront SPA fallback drift;
- an asset returning `text/html` indicates that the fallback is masking a
  missing static asset;
- a fixture/recorded/blocked mode labeled `live`, an enabled approval control
  after an uncommitted edit, or a direct send/execute control is a release
  blocker;
- a console error, uncaught page error, credential-pattern match, or horizontal
  overflow is a release blocker;
- absent API/MCP environment variables are acceptable only before deployment;
  the exact committed/deployed snapshot must later pass those checks.

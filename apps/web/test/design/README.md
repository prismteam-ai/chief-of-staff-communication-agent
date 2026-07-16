# Design tests — no-Figma adaptation (Task 8)

`smeargle`'s `responsive-design-tests` skill is normally driven by a Figma source: per-breakpoint
frames define the expected layout, and the generated Playwright specs assert the deployed UI
against that reference.

This dashboard (`apps/web`) has **no Figma design** — it was built directly from the acceptance
criteria (README L35-L37, L12) and `docs/design.md` §8, not from a visual spec. The adaptation kept
here is the **pattern**, not the Figma dependency:

- **Breakpoint-config objects** (`breakpoints.ts`): named viewport sizes (`mobile`/`tablet`/
  `desktop`) a single generic test body is parameterized over — exactly the kit's shape, just
  sourced from standard device references instead of Figma frame dimensions.
- **One generic test body per concern**, run once per breakpoint via a `for` loop over the config
  array (`dashboard-views.spec.ts`) — adding a fourth breakpoint is a one-line config change.
- **Mocked API, not mocked design**: since there is no visual reference to diff against, these
  specs assert *structure and reachability* (the three required views render, their key data-bearing
  elements are visible, nothing overflows the viewport horizontally) rather than pixel/visual
  regression against a Figma export.

Two test projects (`playwright.config.ts`):

- `test/design/**` — mocked tRPC routes (`test/fixtures/mock-api.ts`), local `vite preview` server,
  deterministic and CI-safe. Run: `pnpm exec playwright test --project=design`.
- `test/browser/**` — one spec against the real deployed Amplify URL (`DASHBOARD_URL` env var),
  real data, real CORS behavior. Not part of `just test` (needs live infra); run manually or as the
  Task 8 live-proof step.

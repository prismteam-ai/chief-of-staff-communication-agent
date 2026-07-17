# Typed Product API

## Purpose

The Chief product API is an executable tRPC surface for the dashboard, browser
application, and other trusted product consumers. It runs through the official
tRPC AWS Lambda adapter and uses the frozen Wave 1 schemas for every contracted
input and output.

The public assessment tenant is selected by the server. No procedure accepts a
tenant, connector account, provider endpoint, table, path, SQL statement, raw
credential, or bearer token as authority.

## Architecture

```text
API Gateway HTTP API
        |
        v
tRPC Lambda adapter
        |
        +-- strict Zod input/output schemas
        +-- server-derived ProductRequestContext
        +-- Powertools observability
        |
        v
injectable ProductService
        |
        +-- deterministic assessment fixture (default)
        +-- durable domain-service adapter (deployment injection point)
```

Routers are deliberately thin. They validate the frozen contract, call one
`ProductService` method with the server-derived request context, validate the
result, and translate bounded service errors into tRPC errors. This keeps the
transport independent from fixture or durable persistence choices.

The default service is deterministic and credentialless. It provides a useful
multi-thread inbox, connector capability states, cited knowledge, action and
draft revisions, focused context requests, approval proposals, related Asana
facts, SLA/dashboard metrics, and a truthful effect-disabled receipt. It makes
no network or provider call.

Product links are derived only from a validated, credential-free HTTPS origin.
Origins containing username/password data, a non-root path, query string, or
fragment fail during service construction before any link is rendered.

## Routes

| Router           | Procedure        |     Kind | Result                                           |
| ---------------- | ---------------- | -------: | ------------------------------------------------ |
| `system`         | `health`         |    query | Frozen compatibility health                      |
| `dashboard`      | `metrics`        |    query | Volume, status/SLA, approvals, channel breakdown |
| `dashboard`      | `sla`            |    query | Frozen SLA snapshot                              |
| `communications` | `list`           |    query | Filtered cursor page                             |
| `communications` | `get`            |    query | Communication, attachments, citations            |
| `communications` | `thread`         |    query | Bounded chronological thread page                |
| `connectors`     | `status`         |    query | Health, runtime mode, exact capabilities         |
| `work`           | `relatedAsana`   |    query | Related Asana task/project facts                 |
| `knowledge`      | `search`         |    query | Authorized candidates and citations              |
| `agent`          | `recommend`      | mutation | Immutable recommendation proposal                |
| `agent`          | `createDraft`    | mutation | Cited immutable draft revision                   |
| `agent`          | `reviseDraft`    | mutation | Immediate immutable successor revision           |
| `agent`          | `requestContext` | mutation | Focused context request                          |
| `approvals`      | `prepare`        | mutation | Immutable approval handoff                       |
| `approvals`      | `prepareAsana`   | mutation | Asana proposal handoff                           |
| `approvals`      | `status`         |    query | Proposal status and HTTPS approval link          |
| `execution`      | `status`         |    query | Truthful public effect-disabled status/receipt   |

There is intentionally no `approve`, `send`, `createTask`, `updateTask`, raw
provider, or storage procedure. Mutation-shaped agent calls only prepare
immutable product records or proposals. Human approval is a separate explicit
product ceremony, and approved effects are consumed by the guarded outbox
worker rather than this API.

## Assessment fixture references

The fixture service exports stable references for automated tests and the demo:

- action plan: `action_plan_fixture_reply`, revision `1`;
- its canonical fixture hash is exported as
  `fixtureProductReferences.actionPlanHash` rather than copied into clients;
- completed non-effect proposal: `proposal_fixture_effect_disabled`.

The completed fixture proposal returns:

```json
{
  "runtimeMode": "fixture",
  "effectPolicy": "effect_disabled",
  "externalEffect": false,
  "status": "effect_disabled",
  "receipt": { "kind": "effect_disabled" }
}
```

It never returns a provider request ID, `provider_accepted`, or `delivered`.

## Pagination and bounds

Communication cursors are opaque, versioned, and bound to the active status
filter. Reusing a cursor with another filter fails with `BAD_REQUEST` rather
than skipping or leaking records. Frozen schemas enforce:

- page limits from 1 through 100;
- knowledge query text up to 16,000 characters;
- at most 100 exact entity references and results;
- revision instructions up to 16,000 characters;
- focused context questions up to 4,000 characters;
- strict objects that reject unknown tenant/account/provider/storage fields.

## Injection

`createApiHandler(dependencies)` accepts a `ProductService` and a
`ProductRequestContext`. Production persistence can implement the same service
without changing routers, `AppRouter`, the generated-style client, or browser
facade. The default Lambda handler injects the credentialless fixture service
and the fixed public assessment scope.

`createApiClient` centralizes the normalized `/trpc` URL and optional safe
header provider. `createBrowserApi` adds runtime parsing for frozen contract
results and exposes product-oriented methods without duplicating tRPC setup.

## Security decisions and tradeoffs

- **Server-selected public tenant:** the fixed fixture identity enables a
  signed-out assessment path without creating caller-selected multi-tenant
  authority. The fixture validates the complete fixed actor, user, account and
  brand scopes, grants, membership version, verified-claims binding, retrieval
  scope, and authorization epoch—not only the tenant ID. Durable authenticated
  deployments replace the injected context, not request schemas.
- **Strict rejection instead of stripping:** unknown input fields and authority
  headers fail visibly. Silent stripping could hide an integration attempting
  to rely on unsafe tenant/account selection.
- **Proposal-only mutations:** the API is less convenient than a direct send or
  Asana mutation endpoint, but approval cannot be bypassed by browser code,
  Cursor auto-run, or a crafted API request.
- **Frozen health compatibility:** Wave 1 froze a health schema containing
  `foundationOnly: true`. The API preserves that wire response to avoid a
  contract edit in this wave; active product readiness is proven by the typed
  route and integration tests. A later contract version should rename this
  compatibility field rather than changing it in place.
- **Fixture state is process-local:** it is appropriate for deterministic,
  networkless assessment behavior and injectable tests. Durable deployments
  must inject repository-backed services; callers and contracts stay stable.

## Verification

Use the repository-pinned Node `22.18.0` and pnpm `10.33.0`, then run:

```powershell
node C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/api test
node C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/api typecheck
node C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/api lint
node C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/api build
node C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/api-client test
node C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/browser-api test
```

The suite covers schema parity, cursor pagination, stale message/
recommendation/draft/action-plan revisions, unsafe product origins, exact
server authority-envelope substitution, unauthorized tenant/account inputs
and headers, channel reconciliation/SMS threads, bounded payloads, malformed
input, absent direct-effect procedures, and API Gateway/Lambda behavior.

## Team Kit provenance

This surface follows the Team Kit `metagross` agent with the
`build-frontend-backends` and `apply-engineering-guidelines` skills:

- TypeScript and strict Zod contracts;
- tRPC through the AWS Lambda adapter;
- one shared typed API client package;
- browser interaction centralized in a reusable package;
- Powertools observability inherited from the foundation;
- Vitest unit and Lambda integration coverage.

Material implementation run: `gpt-5.6-sol`, reasoning level `high`, inherited
from the authoritative Chief Wave 2B outer process.

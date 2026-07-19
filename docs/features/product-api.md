# Typed durable product API

## Purpose

The Chief product API is the executable tRPC surface used by the dashboard and
browser client. The Lambda entry point defaults to the durable composition:
DynamoDB product revisions and approval/execution state, bounded DynamoDB/S3
retrieval, a cited deterministic agent, and optional approval-outbox enqueueing.
The fixture-only service remains a test/local compatibility adapter; it is not
the hosted default.

The public evaluator is signed out but not caller-scoped. The server selects and
validates one fixed deterministic tenant, evaluator user, account, brand,
grants, authorization epoch, and retrieval scope. No procedure or header may
supply tenant, account, provider, table, path, SQL, endpoint, credential, or
bearer-token authority.

## Default composition

```text
API Gateway HTTP API
        |
        v
tRPC Lambda adapter -> strict Zod inputs/outputs
        |
        v
server-derived ProductRequestContext
        |
        v
DurableProductService
  +-- DynamoDurableProductRepository -> core DynamoDB table
  +-- deterministic in-process query-vector producer
  +-- BoundedDynamoS3RetrievalIndex -> promoted snapshot in S3
  +-- cited recommendation/draft agent
  +-- immutable approval/execution record builder
  +-- approval-outbox SQS enqueue (when configured)
```

Outside `NODE_ENV=test`, `createApiHandler()` constructs this AWS composition
from `CORE_TABLE_NAME`, `RETRIEVAL_TABLE_NAME`, `SNAPSHOT_BUCKET_NAME`,
`PRODUCT_BASE_URL`, and optional `OUTBOX_QUEUE_URL`. Missing required bindings
fail startup rather than silently selecting fixture data. Tests can inject a
production-shaped in-memory repository and retrieval port while exercising the
same product service and schemas.

Retrieval uses Owner A's canonical, secret-independent
`retrievalDynamoKeyV1(scope, entityId)` for the exact ingestion head and staged
catalog. The API does not construct a digest `KeyCodec`; that secret-backed
codec remains isolated to canonical ingestion/core persistence. This separation
prevents an API process without the digest secret from deriving a different
retrieval partition than the production writer.

Authorization epoch is not inferred from the current snapshot head. Each
tenant/scope/role domain has an independent, strongly read, monotonic DynamoDB
epoch item. Staging and persisted query-vector entity names include the epoch;
the head/domain partition remains stable so a new-epoch compaction can replace
the prior head without reading old-epoch staging as current input.

The fixed non-PII evaluator projection is regenerated from the source-owned V2
corpus when the product service starts. The durable repository stores a small
identity/integrity marker plus approval and execution state; it does not store
all 1,120 inbox rows or seven connector cards. The projection is deterministic,
credentialless, tenant scoped, and labeled `runtimeMode: fixture` where the
contract describes data origin. `storageMode: durable` independently describes
persisted approval/execution state. Deterministic data must not be relabeled as
a live provider connection.
The V2 connector result contains seven source-owned synthetic connector cards:
six fixture-mode cards and one manual/recorded LinkedIn archive evidence card.
Blocked remains a capability-mode definition with zero hosted evidence; the API
does not fabricate an unavailable card for it.

## Routes

| Router           | Procedure        |     Kind | Result                                                  |
| ---------------- | ---------------- | -------: | ------------------------------------------------------- |
| `system`         | `health`         |    query | Product health with `foundationOnly: false`             |
| `dashboard`      | `metrics`        |    query | Volume, status/SLA, approvals, channel breakdown        |
| `dashboard`      | `sla`            |    query | Bounded SLA snapshot                                    |
| `communications` | `list`           |    query | Filtered cursor page                                    |
| `communications` | `get`            |    query | Communication, attachments, citations                   |
| `communications` | `thread`         |    query | Bounded chronological thread page                       |
| `connectors`     | `status`         |    query | Health, data mode, and exact capabilities               |
| `work`           | `relatedAsana`   |    query | Related Asana task/project facts                        |
| `knowledge`      | `search`         |    query | Scoped bounded candidates and citations                 |
| `agent`          | `recommend`      | mutation | Persisted cited recommendation                          |
| `agent`          | `createDraft`    | mutation | Persisted cited immutable draft revision                |
| `agent`          | `reviseDraft`    | mutation | Immediate immutable successor revision                  |
| `agent`          | `requestContext` | mutation | Focused context request                                 |
| `approvals`      | `prepare`        | mutation | Legacy handoff; durable service requires `prepareDraft` |
| `approvals`      | `prepareAsana`   | mutation | Prepared-only Asana handoff                             |
| `approvals`      | `prepareDraft`   | mutation | Bind exact persisted draft to action plan               |
| `approvals`      | `approve`        | mutation | Server-authorized immutable approval and safe receipt   |
| `approvals`      | `status`         |    query | Durable proposal status and HTTPS deep link             |
| `execution`      | `status`         |    query | Durable pending/effect-disabled status and receipt      |

There is still no public send, provider, create-task, update-task, raw-storage,
or arbitrary action procedure. The `approvals.approve` operation is narrowly
server-authorized for the fixed evaluator scope; it cannot enable an external
effect and always binds the expected current proposal timestamp.

## Retrieval-to-draft path

`knowledge.search`, recommendation, and draft creation call the same bounded
retrieval port. The AWS port:

1. derives the factual role and authorization epoch from the server context;
2. produces a deterministic query vector and binds it to the normalized query
   hash and embedding-profile manifest hash in process;
3. reads only a validated `chief-retrieval.v1` promoted head for that exact
   tenant/scope/role/epoch through `retrievalDynamoKeyV1`;
4. verifies immutable S3 projection/vector objects containing canonical
   evidence text/hash, citation label, exact entity references,
   active/tombstoned state, and mutation ordinal, then applies configured item,
   byte, and RSS bounds;
5. rechecks the authorization epoch, filters tombstones, performs exact-ref plus
   lexical/vector fusion, and returns citations/evidence bound to the actual
   promoted manifest hash;
6. persists the resulting recommendation and cited draft as immutable product
   revisions.

The RAG package also supports scoped persisted query vectors for replay and the
production-writer compatibility test. Hosted API/MCP pass the validated vector
directly to the bounded reader, so their retrieval-table IAM remains read-only.

Agent facts use the canonical evidence text returned by this reader, and the
recommendation/draft provenance contains the reader's actual snapshot manifest
hash. No readable head means retrieval is unavailable; the API does not
fabricate a healthy index or silently fall back to the old fixture RAG service.
The reader strongly checks the independent epoch before loading, after loading,
before scoring, and after citation construction. It retries one observed epoch
transition against the new authority and otherwise fails closed; an old-epoch
snapshot is denied until ingestion promotes a fresh snapshot carrying the new
epoch.

## Durable approval and reload

The approved browser flow is:

1. The evaluator renders the persisted draft body read-only and exposes one
   revision action: **Create concise revision**. It calls `agent.reviseDraft`
   with exactly `Make this draft concise while retaining all cited facts.`
2. `agent.reviseDraft` persists the successor's immutable revision, exact
   revision lookup, and conditionally advanced draft head in one DynamoDB
   transaction using expected-version and expected-revision compare-and-swap
   checks. `agent.createDraft` uses the same atomic shape, so a visible head can
   never outlive or precede its exact lookup.
3. `approvals.prepareDraft` loads that immutable revision, builds the action
   plan and canonical hash, persists a `pending_approval` proposal, and returns
   its HTTPS deep link and update timestamp.
4. `approvals.approve` requires that exact proposal timestamp and the
   server-derived `actions:approve` authority. A stale or already advanced
   proposal returns a conflict.
5. The service builds an immutable approval bundle and operation binding, then
   uses one DynamoDB transaction to write the approval/execution locator,
   aggregate, authority projection, immutable approved proposal revision, and
   conditional proposal-head advance.
6. When `OUTBOX_QUEUE_URL` is configured, the stable operation ID is enqueued
   only after durable state is committed. An SQS failure is returned to the
   caller but does not roll back or hide the committed approval.
7. The persisted aggregate is terminal `effect_disabled`; the receipt contains
   the operation ID, artifact hash, stable idempotency key, and observed time.
8. Fresh service/browser instances read the same state through
   `approvals.status` and `execution.status`.

Recommendation, `createDraft`, proposal preparation, and approval are
idempotent reads of the persisted winner. Once revision 2 is current,
`createDraft` returns that exact revision 2—including its original timestamp—on
reload. Duplicate writes are accepted only when canonical hashes of the full
immutable revision/execution values match. A same-key/different-value replay is
a persistence conflict rather than a false duplicate.

Approval accepts both the originally approved-from timestamp and the current
approved timestamp for safe retry. A retry after successful commit (including
after an SQS failure) re-enqueues the same operation ID and returns the same
approval/receipt; it never creates a new approval or external-effect claim.
Replaying `approvals.prepareDraft` after that approval returns the exact
persisted proposal with `status: approved`, the same action-plan identity/hash,
and the approved update timestamp rather than creating another pending handoff.

The focused API and repository suites cover canonical snapshot evidence and
actual manifest provenance, cited recommendation/draft creation, and the real
service's concise successor. The revision-2 regression proves its body differs
from and is shorter than revision 1 while citations, factual-citation count,
and passed validation are preserved; a restarted service reloads that exact
revision 2. The suites also cover atomic draft revision/exact-lookup/head commit
and failure recovery, idempotent proposal/approval replay, immutable conflict
comparison, post-commit SQS failure/retry with a stable operation ID, stored
effect-disabled execution aggregate, fresh-instance approval/status reload,
and stale proposal rejection.

## Bounds and errors

Frozen schemas enforce bounded pages, result counts, query/instruction lengths,
exact entity references, timestamps, hashes, and strict objects. Communication
cursors are opaque and filter-bound. Known service errors translate to bounded
tRPC results:

- invalid or filter-mismatched cursor -> `BAD_REQUEST`;
- missing durable entity -> `NOT_FOUND`;
- stale revision/proposal -> `CONFLICT`;
- attempted caller authority -> `FORBIDDEN`;
- invalid product operation -> `BAD_REQUEST`.

Unexpected failures are not converted into successful fixture responses.

## Browser clients

`@chief/api-client` centralizes the normalized `/trpc` transport and typed
router surface. `@chief/browser-api` exposes product-oriented bounded methods
and performs runtime result parsing. The web application uses the same-origin
API by default or `VITE_API_BASE_URL` when explicitly configured.

If the hosted API is unavailable, the UI labels a local fallback. That fallback
can demonstrate layout/read states but cannot prepare or approve a durable
revision. The strict hosted Playwright configuration fails before execution
unless a deployed API is supplied and separately asserts that no local fallback
label is present. Hosted URL validation requires HTTPS and a public host, and
rejects credentials, query/fragment authority, single-label/private/local/
reserved/unspecified hosts, and non-public IPv4/IPv6 ranges.

## Verification

Use Node `22.18.0` and pnpm `10.33.0`:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/rag test
pnpm --filter @chief/ingestion-worker test
pnpm --filter @chief/api lint
pnpm --filter @chief/api typecheck
pnpm --filter @chief/api test
pnpm --filter @chief/api build
pnpm --filter @chief/api-client test
pnpm --filter @chief/browser-api test
```

The assessed `f5caa2cfa178961df6d8b68d54e7de7b64d37b83` runtime release is deployed at
`https://d3hgq3e86d3knk.cloudfront.net`, with the product API at
`https://prjip3os8i.execute-api.us-east-2.amazonaws.com`. The deployed evaluator
is authenticated: unauthenticated visitors are redirected to the Cognito Hosted
UI login at `https://d3hgq3e86d3knk.cloudfront.net/auth/login`, and data
endpoints return HTTP 401 without a session cookie. Evaluator credentials are
delivered with the submission and are never committed. The strict authenticated
hosted run completed with **19 runnable checks passed, 2 fixture-only checks
skipped, and 0 failed**. The public corpus is deterministic non-PII fixture data
persisted through the durable composition; it is not authenticated provider
evidence.

## Team Kit provenance

This surface follows the Team Kit `metagross` frontend-backend boundary,
contract-first routing, engineering, RAG, and guarded-approval practices. The
durable composition implementation used `gpt-5.6-sol` with reasoning level
`high`.

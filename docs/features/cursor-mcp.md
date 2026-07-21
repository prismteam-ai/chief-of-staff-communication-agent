# Cursor-accessible durable MCP

## Outcome

`apps/mcp` exposes the Chief product contract through MCP Streamable HTTP. It
supports `initialize`, `tools/list`, `tools/call`, and a cheap
`GET /mcp/health` route on API Gateway/Lambda.

The non-test Lambda entry point now defaults to the same durable
`DurableProductService` used by the API. It imports `@chief/api`, constructs the
AWS DynamoDB/S3 composition, and adapts the shared service to MCP tools. The
hosted default no longer instantiates `FixtureMcpToolService`.

## Architecture

```text
Cursor / MCP Inspector
        |
        | JSON-RPC 2.0 over MCP Streamable HTTP
        v
API Gateway -> Lambda transport -> official MCP SDK server
                                      |
                                      v
                       strict tool schemas + timeout guard
                                      |
                                      v
                           ProductServiceMcpAdapter
                                      |
                                      v
          shared durable API service -> DynamoDB + bounded DynamoDB/S3 RAG
```

The Lambda creates a stateless transport and MCP server for every request. It
does not depend on process affinity, an in-memory session, or an SSE connection
for correctness. `Mcp-Session-Id` is not authority.

Outside `NODE_ENV=test`, startup requires the API's durable AWS bindings:
`CORE_TABLE_NAME`, `RETRIEVAL_TABLE_NAME`, `SNAPSHOT_BUCKET_NAME`, and the
credential-free `CHIEF_PRODUCT_BASE_URL` mapped to `PRODUCT_BASE_URL`. Tests can
inject the production-shaped memory durable service, but the tool adapter,
schemas, authorization checks, and protocol transport are identical.

The shared AWS service reads the same `retrievalDynamoKeyV1` head as ingestion,
uses an in-process bounded/profile-bound query vector, and returns canonical
snapshot evidence with the actual promoted manifest hash. MCP does not own a
parallel key codec, snapshot format, proposal store, or fixture-only RAG path.
Its reads use the independent monotonic authorization-epoch item and the same
consistent pre/post-query rechecks as API retrieval. Epoch-qualified staging/
query keys cannot make old-epoch evidence readable; MCP requires a freshly
promoted new-epoch snapshot.

## Tool surface

| Tool                          | Durable behavior                                         | External effect |
| ----------------------------- | -------------------------------------------------------- | --------------- |
| `list_pending_communications` | Bounded, filtered, cursor-paginated generated projection | None            |
| `get_communication`           | One authorized communication revision with citations     | None            |
| `get_thread_context`          | Bounded thread chronology                                | None            |
| `search_knowledge`            | Promoted-head bounded retrieval and citations            | None            |
| `get_related_asana_work`      | Read-only related task/project context                   | None            |
| `recommend_action`            | Persisted cited recommendation                           | None            |
| `create_draft`                | Persisted cited immutable draft                          | None            |
| `revise_draft`                | Persisted successor draft revision                       | None            |
| `request_context`             | Focused missing-fact request                             | None            |
| `prepare_asana_action`        | Prepared-only Asana handoff                              | None            |
| `submit_for_approval`         | Deprecated compatibility stub; always unavailable        | None            |
| `get_approval_status`         | Read-only durable proposal status                        | None            |
| `get_connector_status`        | Truthful mode, health, and capability facts              | None            |
| `get_sla_metrics`             | Bounded SLA snapshot                                     | None            |

The durable exact-draft approval ceremony lives on the fixed-scope,
server-authorized product API (`approvals.prepareDraft` and
`approvals.approve`); the public evaluator remains signed out. Its persisted
draft body is read-only and its sole revision control is **Create concise
revision**, submitting exactly `Make this draft concise while retaining all
cited facts.` MCP can create/revise a durable draft and poll a proposal prepared
by the product API, but it cannot approve. The legacy
`submit_for_approval` tool is a deprecated compatibility stub. Its listed
description states that it is unavailable, directs clients to the HTTPS product
draft-approval flow, and says that no effect is executed. Calls are rejected
deterministically with the stable `TOOL_UNAVAILABLE` code; it is not a second
approval path. MCP draft creation/revision uses the shared API service's atomic
revision, exact-lookup, and draft-head transaction.

There is intentionally no `approve`, `send_message`, `create_task`,
`update_task`, provider credential, raw table/path/SQL, arbitrary endpoint, or
effect-enable tool. Cursor confirmation and auto-run settings never become
product approval.

## Fixed public scope

- The tenant, evaluator user, account/brand grants, and authorization epoch are
  selected by the server.
- Tool inputs use strict shared Zod schemas. Extra tenant/account/provider or
  storage authority is rejected before service invocation.
- The adapter requires its request scope to match the server-derived API
  context, and output validation recursively rejects cross-tenant data.
- Query strings are rejected, including bearer-token or tenant parameters.
- HTTP request bodies are capped at 64 KiB before JSON parsing.
- Product deep-link output schemas require HTTPS, and CDK injects the
  credential-free CloudFront product origin. No tool accepts URL authority.
- Deterministic non-PII evaluator data is labeled fixture-origin even though its
  product and approval state uses the production durable interfaces.
- The V2 connector status contains seven source-owned synthetic connector cards:
  six fixture-mode cards and one manual/recorded LinkedIn archive evidence card.
  Blocked remains a mode definition with zero hosted evidence, so clients must
  not infer unavailable connector cards.

The current public evaluator does not implement OAuth or account selection.
Use the deployment URL directly without adding a token to the URL or source
configuration. Strict hosted acceptance additionally requires every configured
URL to resolve to a syntactically public HTTPS host: single-label,
private/local/reserved/unspecified names and non-public IPv4/IPv6 ranges are
rejected before Playwright starts.

## Protocol and error behavior

- malformed JSON -> JSON-RPC parse error `-32700`;
- unknown JSON-RPC method -> `-32601`;
- invalid or cross-boundary arguments -> schema/tool error;
- stale immutable revision -> redacted `STALE_REVISION`;
- unknown durable entity -> redacted `NOT_FOUND`;
- retained legacy `submit_for_approval` -> stable `TOOL_UNAVAILABLE`;
- service deadline -> redacted `TOOL_TIMEOUT`;
- oversized body -> HTTP `413` and invalid-request error;
- unexpected failure -> `TOOL_FAILED` or generic transport error.

Raw exceptions, tenant data, credentials, and provider responses are not
serialized. Retrying a read or deterministic immutable mutation cannot invoke
an external provider because all public effect switches remain disabled.

## Local protocol proof

The focused MCP suite exercises:

- `initialize` protocol negotiation;
- exact `tools/list` schema/name parity and absence of direct-effect tools;
- `tools/call` for durable bounded retrieval, cited recommendation and draft;
- approval status for a proposal prepared through the shared durable API
  service, including exact proposal ID/status equality;
- stale revision, unknown proposal/tool, cross-scope input, malformed JSON-RPC,
  unknown method, body limit, query-token rejection, base64 handling, timeout,
  and health.

Run with Node `22.18.0` and pnpm `10.33.0`:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/mcp lint
pnpm --filter @chief/mcp typecheck
pnpm --filter @chief/mcp test
pnpm --filter @chief/mcp build
```

## Strict hosted proof

Use the root documented hosted command. It requires separate UI, API, and MCP
credential-free HTTPS base URLs and has no local fallback or configuration path
that skips a hosted-safe check. Two mock-dependent fixture-only scenarios are
explicitly excluded from the runnable hosted selection:

```powershell
$env:CHIEF_BASE_URL = 'https://<parent-deployment-web-host>'
$env:CHIEF_API_BASE_URL = 'https://<parent-deployment-api-host>'
$env:CHIEF_MCP_BASE_URL = 'https://<parent-deployment-mcp-host>'
pnpm --filter @chief/e2e test:hosted
```

The hosted suite asserts `initialize -> tools/list -> tools/call`, rejects an
approval/send tool, and combines that protocol proof with the browser's
read-only draft, exact concise successor, approval, receipt, and reload/status
journey. Its representative `tools/call` is `get_approval_status` with the
browser-created proposal ID; MCP must return structured content exactly equal
to the API approval status for that same approved proposal.

The assessed `d7c58a66100b75042591c1ab609b6157d032c46b` runtime release is deployed at
`https://d3hgq3e86d3knk.cloudfront.net`, with MCP at
`https://prjip3os8i.execute-api.us-east-2.amazonaws.com/mcp`. The deployed
evaluator is authenticated: unauthenticated browser visitors are redirected to
the Cognito Hosted UI login at
`https://d3hgq3e86d3knk.cloudfront.net/auth/login`, and data endpoints return
HTTP 401 without authentication. Evaluator credentials are delivered with the
submission and are never committed. After the scoped authoritative evaluator
reseed, the strict authenticated hosted run completed with **21 runnable checks
passed, 3 fixture-only checks skipped, and 0 failed**. This is durable fixture
evidence through the production-shaped storage interfaces; it is not live
provider authentication or external-effect evidence.

## Tradeoffs

- **Stateless transport:** favors Lambda portability and bounded requests over
  server notifications that the evaluator does not require.
- **Shared product service:** removes API/MCP behavior drift at the cost of one
  explicit MCP-to-API workspace dependency.
- **Product-owned approval:** keeps approval outside Cursor auto-run and ensures
  the exact revision/timestamp ceremony has one durable authority boundary.
- **Deterministic generated public projection with durable authority state:**
  gives reproducible grading without claiming that inbox rows are stored, a live
  provider connection, or exposed PII. Only the integrity marker,
  approval/execution state, and retrieval head are durable.

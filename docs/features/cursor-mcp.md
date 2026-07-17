# Cursor-accessible remote MCP

Status: Wave 2B implemented for the public assessment fixture.

## Outcome

`apps/mcp` exposes the Chief product contract through standards-compatible MCP
Streamable HTTP. It supports `initialize`, `tools/list`, `tools/call`, and a
cheap `GET /mcp/health` route on the existing API Gateway HTTP API and Lambda
transport.

The public deployment is deliberately read-and-prepare only. Cursor can inspect
communications, retrieve cited context, recommend an action, create or revise a
draft, request missing context, and prepare an approval handoff. It cannot
approve, send a provider message, or create/update Asana work directly.

## Architecture

```text
Cursor / MCP Inspector
        |
        | JSON-RPC 2.0 over MCP Streamable HTTP
        v
API Gateway -> Lambda transport adapter -> official MCP SDK server
                                             |
                                             v
                                  schema-validating tool runtime
                                             |
                                             v
                         injected service or deterministic fixture service
```

The Lambda creates a stateless MCP transport per request. This fits Lambda and
API Gateway without depending on process affinity, in-memory session authority,
or an SSE connection for correctness. The official MCP SDK performs protocol
negotiation and publishes JSON schemas derived from the frozen
`@chief/contracts` Zod schemas.

The service boundary is injectable. Wave 2B supplies a deterministic,
credentialless fixture implementation; a later composition root can inject the
same product services used by the browser API without changing the MCP
protocol, schemas, or approval boundary.

## Tool surface

| Tool                          | Behavior                                             | External effect |
| ----------------------------- | ---------------------------------------------------- | --------------- |
| `list_pending_communications` | Bounded, filtered, cursor-paginated inbox            | None            |
| `get_communication`           | One authorized communication revision with citations | None            |
| `get_thread_context`          | Bounded thread chronology                            | None            |
| `search_knowledge`            | Bounded cited knowledge results                      | None            |
| `get_related_asana_work`      | Read-only related task/project context               | None            |
| `recommend_action`            | Immutable cited recommendation proposal              | None            |
| `create_draft`                | Immutable cited draft revision                       | None            |
| `revise_draft`                | New immutable cited draft revision                   | None            |
| `request_context`             | Focused missing-fact request                         | None            |
| `prepare_asana_action`        | Immutable proposal plus HTTPS approval link          | None            |
| `submit_for_approval`         | Immutable proposal plus HTTPS approval link          | None            |
| `get_approval_status`         | Read-only proposal status                            | None            |
| `get_connector_status`        | Truthful mode, health, and capability facts          | None            |
| `get_sla_metrics`             | Bounded SLA snapshot                                 | None            |

There is intentionally no `approve`, `send_message`, `create_task`,
`update_task`, provider credential, raw table/path/SQL, or arbitrary provider
tool. Cursor confirmation and auto-run settings never become product approval.

## Scope and access boundary

- The assessment tenant, evaluator actor, and authorization epoch are selected
  by the server. No tool accepts a tenant selector.
- Frozen input schemas are strict. Extra tenant/account/provider authority is
  rejected before a service is invoked.
- Parsed tool outputs are checked recursively; any tenant-bearing object from
  an injected service must match the server-derived tenant before it leaves the
  MCP boundary.
- Query strings are rejected, including bearer tokens or tenant identifiers.
- Bearer tokens and provider credentials are never returned, copied into an
  approval URL, or passed downstream.
- `Mcp-Session-Id` is not authorization. This fixture transport is stateless.
- Result and input bounds come from `@chief/contracts`; the HTTP body is also
  capped at 64 KiB before parsing.
- Product deep links must be HTTPS. The deployment should set
  `CHIEF_PRODUCT_BASE_URL` to the credential-free hosted product origin. Paths,
  query strings, fragments, and `user:password@host` authority are rejected;
  local fixture output uses the reserved `https://chief.example.test` origin until
  composition supplies it.

The hosted authenticated profile will derive the same scope from verified
OAuth/OIDC claims and server-side grants. That integration must not add a
caller-selected tenant or downstream provider-token passthrough.

## Product API fixture parity

The public MCP and product API intentionally present one deterministic product
story rather than two independent demos. The MCP fixture mirrors the product
API's server-selected `tenant_public_assessment` and `user_public_evaluator`,
five communication revisions, four threads with email/SMS channel identity,
four connector/account records, two related Asana objects, cited knowledge
identifiers, recommendations, cited draft/context flows, action-plan and
proposal identifiers, effect-disabled proposal status, and SLA snapshot.

Parity is asserted at the MCP protocol boundary, including cursor pagination,
thread membership, connector capability truthfulness, citation/source pairing,
immutable proposal IDs, and the shared counts and latency metrics. The MCP does
not import `@chief/api`; both surfaces implement the frozen contracts behind
injectable services, avoiding a browser/API package dependency in the Lambda.

## Proposal and timeout behavior

Proposal IDs are deterministic over immutable proposal inputs. Repeating the
same MCP request after a client disconnect therefore returns the same proposal
instead of preparing a second logical action. A proposal response contains:

- immutable proposal ID;
- `prepared` or `pending_approval` state;
- HTTPS product approval deep link;
- `directEffectAvailable: false`.

The default tool deadline is five seconds and is injectable for deployed
profiles and tests. A deadline returns the redacted tool error `TOOL_TIMEOUT`;
polling or retrying does not perform a provider/Asana effect. Model-backed
composition must retain the architecture rule from the frozen plan: if measured
deployed p99 plus margin cannot fit the shortest client/gateway/runtime timeout,
return a durable idempotent proposal/job and make status polling read-only.

## Error contract

- Malformed JSON returns JSON-RPC parse error `-32700`.
- Unknown JSON-RPC methods return `-32601`.
- Invalid or cross-boundary tool arguments are rejected by published schemas.
- Unknown tools return a tool-level error and cannot reach a service adapter.
- Stale immutable revisions return the redacted tool error `STALE_REVISION`.
- Oversized HTTP bodies return HTTP `413` with JSON-RPC invalid-request error.
- Unexpected failures return only `TOOL_FAILED` or a generic transport error;
  raw exceptions, credentials, tenant data, and provider responses are not
  serialized.

## Verification

The focused suite covers:

- initialize negotiation and generated tool schemas;
- exact frozen tool-name parity and direct-effect-tool absence;
- cited knowledge candidate/citation alignment;
- public product API fixture parity for communications, thread channels,
  connectors, Asana facts, knowledge IDs, recommendations/drafts/context,
  proposal status, and SLA metrics;
- deterministic proposal idempotency and HTTPS approval links;
- stale revision, cross-tenant/account input, unknown direct-effect tool,
  malformed JSON-RPC, unknown method, oversized input, and query-token denial;
- API Gateway base64 behavior;
- bounded timeout behavior;
- cheap truthful health behavior.

Run with the repository-pinned Node `22.18.0`:

```powershell
node C:\Program` Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/mcp test
node C:\Program` Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/mcp lint
node C:\Program` Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/mcp typecheck
node C:\Program` Files\nodejs\node_modules\pnpm\bin\pnpm.cjs --filter @chief/mcp build
```

## Tradeoffs

- **Stateless JSON responses over stateful/SSE-first sessions:** Lambda requests
  remain portable and horizontally scalable. Server notifications and durable
  resumability are deferred until a real Cursor compatibility test proves they
  are required.
- **Frozen contract breadth over an ad hoc demo tool:** all product-facing MCP
  tools share browser/API schemas now, which adds fixture work but prevents
  protocol drift.
- **Deterministic fixture service over provider-backed calls:** the public MCP
  is reproducible and safe without credentials. It is labeled fixture and does
  not claim live retrieval, generation, provider delivery, or Asana mutation.
- **Product approval deep link over MCP approval:** this adds one intentional
  human step and preserves the immutable approval/outbox invariant even when
  Cursor auto-runs tools.

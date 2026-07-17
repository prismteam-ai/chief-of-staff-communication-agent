# Asana work-management connector

## Boundary

Asana is implemented only as the frozen `WorkManagementConnector`. It is not a
communication channel and cannot be registered or resolved through the
`CommunicationConnector` registry.

The implementation lives behind the existing package wildcard exports:

- `@chief/work-management-asana/connector`
- `@chief/work-management-asana/implementation-metadata`
- `@chief/work-management-asana/types`
- `@chief/work-management-asana/webhook`

The original disabled scaffold metadata and package barrel remain unchanged.
The implementation descriptor truthfully declares OAuth, scoped reads,
webhooks, polling, and task/update/comment effects. The connector has no
default HTTP client, provider endpoint, token reader, credential reader, or
environment-variable access. Provider I/O, OAuth completion, the clock, and
immutable effect-payload loading are constructor-injected ports.

## OAuth and account scope

`beginAuthorization` produces the Asana authorization URL with the frozen
state digest, callback URI, and PKCE S256 challenge. OAuth completion is
delegated to the injected authorization port and accepts a result only when
tenant, user, provider, account, and connector snapshot bindings match.

Every connector instance is restricted to one configured workspace and an
explicit project allowlist. Connection health verifies that `/users/me`
contains the configured workspace. A task, milestone, or comment target must
belong to both the configured workspace and an allowlisted project. A project
must belong to the workspace and its own GID must be allowlisted. Matching only
one dimension fails closed.

The provider-shaped read projections cover:

- tasks through `/tasks/{gid}`;
- projects through `/projects/{gid}`;
- milestones through `/tasks/{gid}` with
  `resource_subtype=milestone`;
- comments through `/stories/{gid}` with a scoped target task.

The connector returns only the canonical immutable `WorkObjectFact`: object
kind/GID, provider timestamp/version, and a deterministic response
fingerprint. Provider bodies remain facts at the adapter boundary.

## Webhooks and bounded reconciliation

The handshake reflects `X-Hook-Secret` only for a valid POST. Event delivery
requires `X-Hook-Signature`, verified as HMAC-SHA256 over the exact raw body
using a timing-safe comparison. Invalid signatures and malformed event bodies
are rejected before event interpretation.

Asana webhook notifications are compact invalidations. Verified events retain
the action, object kind, GID, provider timestamp, and a deterministic event ID;
the connector then refetches the authoritative object before canonical use.
An empty signed event batch is recorded as the webhook heartbeat. Renewal is a
read-only heartbeat/reconciliation lookup of the existing webhook; it does not
replace or duplicate the subscription.

Because notifications can be missed, polling uses the provider sync cursor and
bounded `/events` pagination. `maxPages` and `maxItems` are hard limits. A
remaining provider offset returns `complete=false` and the next cursor; no page
is silently dropped. A 429 exposes the provider `Retry-After` value and is not
retried inside the adapter. Connector core owns durable checkpoint advancement
after canonical writes and event-outbox persistence. Every poll fact carries
the server-owned current connector snapshot injected at construction; fixture
events remain labeled `virtual_test` and can never be relabeled as live.

## Guarded effects

There is no provider-shaped mutation API exported from this package. The only
effect entry point required by the SPI is:

```text
execute(accountRef, immutable EffectExecutionArtifact)
```

The injected payload store resolves the already-rendered immutable Asana
operation by artifact. The connector recomputes the payload fingerprint and
requires it to equal `renderedPayloadFingerprint` before provider I/O. Create
scope requires the configured workspace and, when a project allowlist exists,
an explicitly selected allowlisted project. Update and comment
operations refetch the task and compare `modified_at` immediately before the
write; stale preconditions fail without a mutation call.

Provider responses bind the returned task/story GID as
`providerCorrelation`. The guarded connector-core path persists the client
correlation before dispatch and the returned GID before
`provider_accepted`. The stable idempotency key is carried as the operation ID
to the injected transport, but the connector does not claim Asana provides
universal create idempotency.

The result policy is fail-closed:

- validated 2xx plus returned GID: `accepted`;
- deterministic 4xx/precondition/rate-limit response: `rejected`;
- timeout, transport error, 5xx, or 2xx without returned GID:
  `acceptance_unknown`.

`acceptance_unknown` is frozen by connector core and cannot enter ordinary
retry. The only next step is bounded reconciliation through the injected
read-only reconciliation port. Proven non-acceptance permits the same immutable
operation to be retried under approval/outbox policy. An unresolved result
remains frozen; a possible duplicate requires a fresh operation, risk
acknowledgement, action-plan revision, and approval outside this adapter.

## Networkless verification

The deterministic suite uses realistic Asana response envelopes (`data`, GIDs,
resource types/subtypes, memberships, workspace, pagination, sync token,
webhook headers, rate-limit headers, and error arrays). All clocks, OAuth
completion, payloads, transport calls, and reconciliation results are injected
in memory. The tests contain no credentials and make no network, OAuth,
webhook, workspace, model, or AWS call.

Run on Node `22.18.0`:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/work-management-asana test
pnpm --filter @chief/work-management-asana lint
pnpm --filter @chief/work-management-asana typecheck
pnpm --filter @chief/work-management-asana build
```

The tests include the shared `runWorkManagementConnectorContract` suite plus
Asana-specific OAuth, scoped retrieval, pagination/rate-limit, handshake/HMAC,
heartbeat, compact refetch, polling-gap reconciliation, returned-GID,
idempotency binding, precondition, ambiguous-effect, and unknown-acceptance
cases.

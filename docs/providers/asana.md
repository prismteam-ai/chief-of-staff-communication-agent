# Asana work-management connector

## Boundary and production composition

Asana implements only the frozen `WorkManagementConnector`. It is not a
communication channel and cannot be registered through the
`CommunicationConnector` registry.

The package root exports `AsanaRestTransport`,
`AsanaWorkManagementConnector`, the live descriptor, and
`createAsanaLiveComposition`. The only resolvable subpaths are `acceptance`
and `acceptance-cli`; there is no wildcard export. Provider-shaped fixtures,
canonical helpers, tests, and other internals cannot resolve through the
package export surface. The disabled scaffold metadata remains available at
the root under its explicitly named compatibility export.

Provider I/O, credential custody, OAuth completion, immutable effect-payload
loading, clock, and optional abort signal remain constructor-injected ports.
The live composition does not enable the deployed Lambda, add a provider sink
to it, or change any CDK effect switch.

## REST transport

`AsanaRestTransport` uses Node's built-in `fetch` and adds no dependency. It
is hard-bound to `https://app.asana.com/api/1.0`; the origin is not a
constructor or command-line option. It:

- accepts only relative API paths and rejects raw or percent-encoded dot
  traversal, alternate hosts, encoded separators, and every redirect;
- obtains the PAT through an injected callback-scoped credential source and
  never stores it on the transport instance;
- sends the PAT only in the bearer header, never in a URL, command argument,
  error, evidence record, checkpoint, or log;
- enforces a fixed per-request deadline with `AbortSignal`, a 64 KiB request
  ceiling, a 1 MiB response ceiling, and JSON content type; an abort listener
  cancels an active body reader immediately even if the stream never yields;
- makes exactly one fetch attempt, including for `429`, timeout, transport
  failure, and `5xx`;
- retains only status, a grammar/length-validated provider request ID, and a
  bounded integer `Retry-After` value from response headers.

A stable operation ID is SHA-256 reduced before entering the client-request
header. This is correlation only: Asana universal idempotency is not claimed.

## OAuth, account, and object scope

`beginAuthorization` produces the Asana authorization URL with the frozen
state digest, callback URI, and PKCE S256 challenge. OAuth completion stays
delegated to an injected authorization port and accepts a result only when
tenant, user, provider, account, and connector snapshot bindings match. The
PAT-based assessment CLI does not expose or simulate OAuth completion.

Each connector instance is restricted to one workspace and an explicit
project allowlist. `/users/me` must contain the configured workspace. A task,
milestone, or comment must belong to both that workspace and an allowlisted
project. A project must belong to the workspace and its own GID must be
allowlisted. Matching only one dimension fails closed.

Provider-shaped reads cover tasks, projects, milestones, and comments. The
connector returns only canonical immutable `WorkObjectFact` values: kind/GID,
provider timestamp/version, and deterministic response fingerprint. Provider
bodies remain adapter-boundary facts.

## Webhooks, polling, and rate limits

Webhook handshake reflects `X-Hook-Secret` only for a valid POST. Delivery
requires `X-Hook-Signature`, verified as HMAC-SHA256 over the exact raw body
using timing-safe comparison. Compact invalidations are refetched before
canonical use; empty signed batches are heartbeats. Renewal performs a
read-only lookup of the existing webhook and never duplicates it.

Polling uses the provider sync cursor and bounded `/events` pagination.
`maxPages` and `maxItems` are hard limits. A remaining offset yields
`complete=false`; no page is silently dropped. A `429` exposes the bounded
`Retry-After` value and is never automatically retried. Connector core owns
durable checkpoint advancement after canonical writes and event-outbox
persistence.

## Immutable guarded effects and reconciliation

There is no provider-shaped mutation API exported from the package. The only
SPI effect entry is:

```text
execute(accountRef, immutable EffectExecutionArtifact)
```

The injected payload store resolves the already-rendered operation. The
connector recomputes its fingerprint and requires exact equality with
`renderedPayloadFingerprint`. Create requires the configured workspace and an
explicit allowlisted project. Update and comment refetch the task and compare
`modified_at` immediately before writing. A stale precondition performs no
mutation. Update acceptance also requires the returned task GID to equal the
approved target GID; a mismatched 2xx response freezes as unknown through the
guarded connector-core path.

The connector-core path persists client correlation before dispatch and the
returned task/story GID before `provider_accepted`. Results are fail closed:

- validated 2xx plus returned GID: `accepted`;
- deterministic 4xx, precondition, or rate-limit result: `rejected`;
- timeout, transport failure, 5xx, or 2xx without GID:
  `acceptance_unknown`.

Unknown acceptance freezes and cannot enter ordinary retry. Reconciliation is
read-only and bounded. Create checks at most two pages/100 project tasks for
an exact approved name after directly verifying the project GID and workspace
scope: one match proves acceptance, while multiple matches or incomplete
enumeration remain unknown. Update directly reads the task and compares
approved fields; drift from the precondition without a match remains unknown.
The implementation does not use workspace search because Asana search may be
unavailable by plan and is unsuitable for immediate read-after-write
reconciliation.

## Bounded live acceptance

The package CLI validates `/users/me`, discovers bounded workspace/project
choices, and—with exact GIDs—uses the real connector to read the selected
project and every bounded selected task. Read-only mode has no mutation path.
Its JSON evidence contains only counts, hashes, GIDs, scopes, statuses, and
validated provider request IDs. It omits names, descriptions, notes, comments,
email/login fields, credentials, URLs, and raw bodies.

The credential flag accepts only a file path. The dependency-free parser
supports the existing dotenv-shaped operator file, reads only `ASANA_PAT`,
tolerates other syntactically valid account fields, rejects duplicate/missing/
multiline PAT values, and performs no interpolation or shell evaluation.

Controlled mutation is impossible unless these bind before credential read or
provider I/O:

- `--allow-controlled-mutation`;
- exact workspace and project GIDs;
- a safe unique 16–64 character marker;
- a separate local authorization JSON record binding that scope and marker,
  exactly `create_task` plus `update_task`, and a future expiry.

Before create, the CLI requires complete bounded project-task enumeration and
requires a valid name on every enumerated task; a missing name makes marker
absence unprovable and fails before write. It rejects any name containing the
marker, dispatches one clearly named task create through
`dispatchWorkManagementEffect`, reads the returned task through the connector,
then dispatches one `modified_at`-precondition-bound name update through a
second immutable artifact and reads it again. Both read-backs require the exact
authorized name. Ambiguous acceptance enters connector-core reconciliation and
is never resent; a proven single match may settle it, while incomplete or
multiple matches remain frozen. No delete operation exists. A rerun with the
same marker fails before write.

Create the local authorization record outside terminal history in an
operator-controlled editor. Use this exact placeholder-only schema:

```json
{
  "schemaVersion": "1",
  "kind": "asana_controlled_assessment_authorization",
  "authorizationId": "<unique-authorization-id>",
  "workspaceGid": "<exact-workspace-gid>",
  "projectGid": "<exact-project-gid>",
  "assessmentMarker": "<unique-assessment-marker>",
  "authorizedOperations": ["create_task", "update_task"],
  "expiresAt": "<future-ISO-8601-timestamp>"
}
```

## Exact Node 22 operator commands

Run from the repository root. These commands contain paths and placeholders
only; the PAT never appears on the command line.

```powershell
$ASANA_CREDENTIAL_FILE_PATH = '..\.config\<asana-env-file>'
$ASANA_WORKSPACE_GID = '<exact-workspace-gid>'
$ASANA_PROJECT_GID = '<exact-project-gid>'
$ASANA_AUTHORIZATION_FILE_PATH = '..\.config\<asana-authorization-file>.json'
$ASANA_ASSESSMENT_MARKER = '<unique-assessment-marker>'

& 'E:\nvm\v22.18.0\pnpm.CMD' --filter @chief/work-management-asana build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Read-only run 1.
& 'E:\nvm\v22.18.0\node.exe' packages/work-management-asana/dist/acceptance-cli.js `
  --credential-file $ASANA_CREDENTIAL_FILE_PATH `
  --workspace-gid $ASANA_WORKSPACE_GID `
  --project-gid $ASANA_PROJECT_GID `
  --max-items 20 `
  --max-pages 2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Read-only run 2: identical command proves bounded restart behavior.
& 'E:\nvm\v22.18.0\node.exe' packages/work-management-asana/dist/acceptance-cli.js `
  --credential-file $ASANA_CREDENTIAL_FILE_PATH `
  --workspace-gid $ASANA_WORKSPACE_GID `
  --project-gid $ASANA_PROJECT_GID `
  --max-items 20 `
  --max-pages 2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Run once with a fresh marker and matching local authorization record.
& 'E:\nvm\v22.18.0\node.exe' packages/work-management-asana/dist/acceptance-cli.js `
  --credential-file $ASANA_CREDENTIAL_FILE_PATH `
  --workspace-gid $ASANA_WORKSPACE_GID `
  --project-gid $ASANA_PROJECT_GID `
  --max-items 20 `
  --max-pages 2 `
  --allow-controlled-mutation `
  --authorization-file $ASANA_AUTHORIZATION_FILE_PATH `
  --assessment-marker $ASANA_ASSESSMENT_MARKER
```

If exact GIDs are unknown, omit both GID flags for bounded workspace IDs,
then pass one exact workspace GID without a project GID for bounded project
IDs. Choice evidence contains IDs only, never names.

The second read-only run is stateless: no token, raw body, name, or opaque
pagination cursor is persisted. Controlled rerun safety comes from complete
bounded marker enumeration, not from an unsupported idempotency claim.

## Networkless verification

No live acceptance has been run or claimed by this document. On Node
`22.18.0`, run:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @chief/work-management-asana test
pnpm --filter @chief/work-management-asana lint
pnpm --filter @chief/work-management-asana typecheck
pnpm --filter @chief/work-management-asana build
```

The deterministic suite uses realistic Asana envelopes and makes no network,
credential, OAuth, webhook, workspace, model, or AWS call. It includes the
shared work-management contract plus OAuth/scope, webhook/HMAC, pagination,
rate-limit, immutable effect, stale precondition, ambiguous acceptance, and
unknown-freeze cases. Transport/acceptance adversarial tests cover host and
redirect rejection, token redaction, request/response/deadline/content-type
bounds, no retry, malformed dotenv, duplicate markers, incomplete absence
proof, bounded reconciliation, authorization binding, and actual export
resolution rejection.

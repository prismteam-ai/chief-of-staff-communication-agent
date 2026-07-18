# AWS deployment

Status: the assessed `2ad8432a8c8a48f9e2e5d3864944eb7541d2c500` release is
deployed. `ChiefProductStack` and `ChiefFoundationStack` are both
`UPDATE_COMPLETE`; scoped deterministic non-PII evaluator data is seeded; and
strict hosted acceptance passed 19 runnable checks with 2 fixture-only skips
and 0 failures.

## Runtime shape

The assessment runtime is two stacks in AWS account `417242953053`, region
`us-east-2`:

- `ChiefProductStack` owns the customer-managed KMS key, three on-demand
  DynamoDB tables, private immutable S3 snapshot/blob bucket, ingestion and
  approval-outbox queues with DLQs, EventBridge bus, generated digest-key
  secret, workers, alarms, and runtime exports.
- `ChiefFoundationStack` preserves the existing CloudFront distribution and
  HTTP API, deploys the static web build, and binds the API and MCP Lambdas to
  the product-stack exports with separate resource-scoped IAM profiles. The API
  reads/writes durable product and approval state, reads the immutable snapshot,
  prepares scoped query vectors, and can enqueue only the outbox. MCP uses the
  same durable product/retrieval service but has no outbox-send, event-bus, or
  secret access.

The product stack is an explicit dependency of the foundation stack. Deploying
both stack IDs in one command therefore creates or updates product exports
before the API/MCP imports. Existing `WebUrl` and `ApiUrl` outputs retain their
logical resources; new outputs add direct health/MCP endpoints and same-origin
CloudFront API/MCP endpoints.

No OpenSearch resource is created. The assessment profile uses the bounded
DynamoDB/S3 retrieval contract.

Outside tests, both public Lambda entry points fail closed into this durable
composition. The API requires `CORE_TABLE_NAME`, `RETRIEVAL_TABLE_NAME`,
`SNAPSHOT_BUCKET_NAME`, and `PRODUCT_BASE_URL`; MCP maps
`CHIEF_PRODUCT_BASE_URL` into the same API composition. The API additionally
uses `OUTBOX_QUEUE_URL` when approval enqueueing is configured. The hosted
defaults do not construct the fixture-only product or MCP services.

### Production ingestion composition

`ChiefProductStack` invokes the ingestion worker only through its SQS event
source. The exported Lambda handler consumes `SQSEvent` and returns partial
batch failures by SQS `messageId`; the deterministic direct
`IngestionEvent` handler remains a test/fixture constructor and is not the
deployed entry point.

The queue accepts only EventBridge envelopes whose source is
`chief.connectors` and whose detail type is
`communication.ingest.requested`. The detail carries one server-derived
tenant/account/brand/authorization scope and the canonical ingestion event.
The runtime rejects a work item that does not match that authority or the
deployment-owned connector/version binding. `demo` and fixture/disabled
runtime modes are not admitted by the production composition.

The worker receives this explicit configuration:

| Environment variable                      | Bound value class                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `INGESTION_RUNTIME_MODE`                  | Literal `production`; missing or different fails closed                             |
| `CORE_TABLE_NAME`                         | CDK token for the core table                                                        |
| `CONNECTOR_RUNTIME_TABLE_NAME`            | CDK token for the fenced checkpoint/runtime table                                   |
| `RETRIEVAL_TABLE_NAME`                    | CDK token for the bounded retrieval table                                           |
| `SNAPSHOT_BUCKET_NAME`                    | CDK token for the private immutable body/snapshot bucket                            |
| `DIGEST_KEY_SECRET_ARN`                   | ARN reference to the generated `{version,key}` digest secret; never secret material |
| `PRODUCT_DATA_KEY_ARN`                    | ARN reference to the customer-managed data key                                      |
| `INGESTION_THREAD_LOOKUP_INDEX_NAME`      | `ThreadLookupIndex`                                                                 |
| `INGESTION_IDENTITY_LOOKUP_INDEX_NAME`    | `IdentityLookupIndex`                                                               |
| `INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME` | `AsanaTopicLookupIndex`                                                             |
| `INGESTION_CONNECTOR_BINDINGS`            | Fixed `source=connector@descriptor-version` deployment allowlist                    |

The three lookup indexes have partition keys only and bounded `INCLUDE`
projections containing exactly the fields consumed by the Dynamo persistence
adapter. The worker can read/write the three product tables, read/write the
private bucket, consume its queue, and read the exact digest secret. It has no
outbox-send, EventBridge-publish, Bedrock, Lambda-invoke, SES, SNS-publish, or
provider credential authority.

### `chief-retrieval.v1` staging and promotion

Production ingestion and bounded retrieval share one versioned contract; there
is no legacy NDJSON delta/read-snapshot dual format.

1. Canonical ingestion/core records continue to use the secret-backed digest
   `KeyCodec`. Durable retrieval separately uses
   `retrievalDynamoKeyV1(scope, entityId)`, a versioned, validated,
   secret-independent key contract. Production writers and API/MCP readers call
   this literal function, so missing digest material cannot split retrieval
   partitions.
2. Each tenant/scope/role authorization domain has an independent DynamoDB
   `authorization-epoch` item. Its update condition is monotonic: the epoch may
   initialize or advance but cannot move backward. Staging and persisted
   query-vector entity names include the epoch, while the domain/head key stays
   stable across transitions.
3. `S3RetrievalMutationSink` converts the canonical ingestion write into an
   immutable upsert or tombstone. Every record carries canonical evidence text,
   its content hash, citation label, exact entity references,
   active/tombstoned state, mutation ordinal, and deterministic binary32 vector.
   The object is content addressed under the tenant/scope snapshot prefix.
4. `DynamoS3RetrievalAuthority.register` advances/checks the independent epoch
   and writes the immutable staged manifest under that exact epoch-qualified
   catalog. A duplicate is accepted only when the complete manifest is
   canonically identical.
5. `CompactingRetrievalRegistrar` consistently enumerates the registered scope
   through bounded DynamoDB `Query` pages (up to 256 per page, 40 pages, and
   10,000 total). Empty/repeated continuations fail closed. It reads the current
   head, compacts the bounded catalog, and retries a stale CAS at most three
   times. No separate parent compactor or fixture promotion is required.
6. `DurableRetrievalCompactor` deduplicates mutation IDs, orders changes by
   staging ordinal and mutation ID, and applies only mutations newer than the
   snapshot record's ordinal. A conflicting equal ordinal fails closed. A newer
   tombstone remains snapshot-resident and cannot be resurrected by replaying an
   older upsert.
7. Compaction sorts final records by UTF-8 chunk ID and writes exactly the
   newline-delimited projection and `binary32-le-row-major` vector objects
   consumed by `BoundedDynamoS3RetrievalIndex`. Snapshot-contained evidence,
   exact refs, and active/tombstoned state are therefore the reader's canonical
   authorization/citation surface.
8. The compactor hashes the manifest and asks the real bounded reader to apply
   the snapshot before promotion. Promotion is one DynamoDB transaction: a
   `ConditionCheck` requires the independent authority item to equal the
   proposed epoch, and the second item conditionally creates/replaces the head
   at the expected manifest hash. A concurrent epoch advance or head writer
   therefore makes the CAS stale. Replay against a later head with zero newly
   applied mutations returns `unchanged`, preserves that exact head, and
   advances neither generation nor published sequence.
9. Publication start/end advances by applied mutation count. The limits are
   10,000 staged mutations, 64 MiB staged bytes, 10,000 snapshot chunks, 64 MiB
   serialized snapshot bytes, 128 MiB decoded bytes, plus an
   RSS/available-memory guard. Health remains unavailable until a readable
   validated head exists.
10. Query preparation normalizes text, derives the profile-bound hash, and
    produces the deterministic effect-disabled 32-dimensional vector. The
    package supports persisted vectors for replay/compatibility proof; API/MCP
    pass the bounded validated vector in process and keep retrieval IAM
    read-only. The reader rechecks the authorization epoch, filters tombstones,
    uses snapshot exact refs for fusion, and returns canonical
    evidence/citations with the actual promoted manifest hash.

The reader strongly reads the independent epoch before loading a head, after
snapshot load, before scoring, and after building citations. It can retry one
observed transition using the new authority value, but it never treats the old
head as authorized for the new epoch. Once the epoch advances, old-epoch queries
are denied until ingestion registers new-epoch staging and promotes a fresh
snapshot/head carrying that epoch. Stale-epoch registration and promotion fail
closed.

The focused integration suite runs the actual production staging writer through
deduplicating compaction, CAS promotion, persisted query-vector production,
healthy bounded retrieval, and cited output. Additional contract tests reject
stale writers, foreign tenants, corrupt objects, catalog pagination loops,
conflicting ordinals, excess items/bytes, and excess RSS; they also prove
cross-head replay does not advance sequence and tombstones dominate older
upserts. Epoch-transition coverage additionally proves monotonic authority,
epoch-qualified catalog isolation, old-epoch denial, fresh new-epoch promotion,
transactional epoch/head fencing, and stale-writer rejection.

These local suites use deterministic in-memory AWS-port adapters. They prove
the application contracts and recovery decisions, not AWS service enforcement
of DynamoDB transactions, S3 versioning, KMS policies, or Object Lock. Template
assertions and post-deployment checks are the separate evidence for those AWS
properties.

After a fresh product-stack deployment, run the executable
[`seed:evaluator-retrieval`](deterministic-evaluator-seed.md) operator command.
It uses this exact writer, bounded catalog, compactor, CAS, and reader-validation
composition for the fixed evaluator authority. The command is idempotent,
prints a non-secret JSON identity, and rejects stale/mixed state before staging;
no console write or hosted in-memory retrieval fallback is required.

### Durable API approval composition

The fixed deterministic non-PII evaluator projection is regenerated from the
source-owned V2 corpus when the product service starts. The core repository
stores only its small identity/integrity marker, not all 1,120 inbox rows or
seven connector cards. Recommendations, cited drafts, draft successors, and
proposals use immutable revisions plus conditional heads in the same core table.
Each draft create/revise commits the immutable revision, its exact revision
lookup, and the conditional head compare-and-swap in one DynamoDB transaction.
An interrupted or losing writer cannot expose a draft head without the exact
lookup required by approval and restart.

The V2 evaluator projection contains seven account-scoped fixture connector
cards over 1,120 synthetic primary messages in 160 threads and two brands. Its
capability-mode legend still defines recorded and blocked, but both have zero
hosted evidence in the deterministic seed and therefore no recorded or blocked
connector cards.

Recommendation/draft facts are the snapshot's canonical evidence text, and
their provenance is the actual promoted manifest hash. Replay returns the
persisted current value and original timestamp: once revision 2 is current,
`createDraft` reloads that exact revision 2. Duplicate revision/approval records
are accepted only when canonical hashes of the complete immutable values match;
same-key/different-value data is a conflict.
After approval, `prepareDraft` replay returns the same proposal as `approved`
with its exact action-plan binding and approved update timestamp.

The evaluator presents the persisted draft body read-only and exposes only
**Create concise revision**, which submits exactly `Make this draft concise
while retaining all cited facts.` The real durable-service regression proves
that revision 2 differs from and is shorter than revision 1 while preserving
citations, factual-citation count, passed validation, and exact restart reload.

`approvals.approve` requires the server-derived `actions:approve` grant and the
exact pending proposal update timestamp. One DynamoDB transaction writes the
approved immutable proposal revision, conditionally advances its head, and
creates the approval/execution locator, aggregate, and authority records. The
API then enqueues the stable operation ID when `OUTBOX_QUEUE_URL` is configured.
The public operation persists a terminal effect-disabled receipt before enqueue;
it never claims a provider or Asana request. If SQS fails, approval/status stays
readable. Retrying with the approved-from or current approved timestamp
re-enqueues the same operation ID and returns the same receipt.

`approvals.status` and `execution.status` reload that durable state. MCP shares
the product service for retrieval/draft/status, but exposes no approval or
direct-effect tool and has no outbox queue authority.

### Production approval execution composition

The deployed execution Lambda consumes the approval-outbox queue through its
module-level `handler`. Its complete lane-specific configuration is:

| Environment variable          | Bound value class                                            |
| ----------------------------- | ------------------------------------------------------------ |
| `EXECUTION_RUNTIME_MODE`      | Literal `effect_disabled`; missing or different fails closed |
| `CORE_TABLE_NAME`             | CDK token for the authoritative core table                   |
| `EXECUTION_WORKER_ID`         | Stable deployment identity `chief-execution-worker`          |
| `EXECUTION_LEASE_DURATION_MS` | Deployment-owned lease `120000`                              |
| Four effect switches          | Literals `disabled`                                          |

The handler constructs the AWS DynamoDB document client and
`DynamoApprovalExecutionPersistence`, then uses only `EffectDisabledSink`.
There is no provider connector, provider endpoint/credential, external send,
or in-memory success fallback in this lane. A successful invocation means an
approved immutable operation was guarded and a truthful `effect_disabled`
receipt was conditionally persisted; it is not evidence of provider
acceptance.

The core-table aggregate, operation-unique base-table locator, and versioned
authority-projection contract is documented in
[effect-execution.md](../features/effect-execution.md). Strong locator reads and
transactional aggregate/authority reads do not use a GSI or scan. The execution
role can get, transactionally read, and conditionally update only the core
table, plus consume the encrypted outbox queue. It has no transactional-write,
put, connector-runtime or retrieval-table, S3, EventBridge, Secrets Manager,
queue-send, provider, or mutable-fact authority. The function has no reserved
concurrency; its event source retains the bounded maximum concurrency of `2`.

## Safety defaults

Every Lambda receives four independent disabled switches:

- `EXTERNAL_EFFECTS=disabled`
- `PROVIDER_EFFECTS=disabled`
- `WORK_MANAGEMENT_EFFECTS=disabled`
- `MODEL_EFFECTS=disabled`

The API and MCP additionally receive a fixed `chief-evaluator-fixture` tenant
and a bounded public route-scope label. Only `/trpc/{proxy+}`, `/mcp`, and
`/mcp/{proxy+}` exist at API Gateway. Public fixture execution must end in the
credentialless `effect_disabled` receipt; these settings do not authorize a
provider send, Asana mutation, or model call.

Do not override switches in the Lambda console. A controlled effect requires a
reviewed, committed CDK change plus the assignment's approval and recipient
eligibility gates. Console drift is not a supported enablement path.

The template contains resource names, ARNs, queue URLs, and one generated
Secrets Manager recipe only. It contains no provider credential value. The
digest material is generated by Secrets Manager at deployment and functions
receive only its ARN.

## Prerequisites

1. Use Node `22.18.0` and pnpm `10.33.0` from the repository's pinned
   toolchain.
2. Select an existing AWS profile without committing or documenting its local
   name.
3. Verify the caller is account `417242953053` and the selected region is
   `us-east-2`.
4. Run the repository secret-policy self-test and scan before any credential
   ingress. Follow [credential-ingress.md](credential-ingress.md); never echo,
   log, or pass credential values as CDK context.
5. Build the complete workspace before synth so `apps/web/dist` and every
   Lambda entry are present.

PowerShell preflight:

```powershell
$ChiefAwsProfile = '<selected-profile>'
$env:AWS_PROFILE = $ChiefAwsProfile
$env:AWS_REGION = 'us-east-2'
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH

node --version
pnpm --version
aws sts get-caller-identity --profile $ChiefAwsProfile
aws configure get region --profile $ChiefAwsProfile
node tools/secret-policy/self-test.mjs
node tools/secret-policy/scan.mjs --repo . --format text
```

Stop if the account is not `417242953053`, the region is not `us-east-2`, or a
secret-policy command is nonzero.

## Verify and synthesize

Run from the repository root:

```powershell
pnpm format:check
pnpm --filter @chief/rag test
pnpm --filter @chief/ingestion-worker test
pnpm --filter @chief/api test
pnpm --filter @chief/mcp test
pnpm --filter @chief/web test
pnpm --filter @chief/e2e typecheck
pnpm --filter @chief/e2e test
pnpm --filter @chief/infra-cdk lint
pnpm --filter @chief/infra-cdk typecheck
pnpm --filter @chief/infra-cdk test
pnpm build
pnpm --filter @chief/infra-cdk synth
pnpm verify:force
```

The synth command fixes the account and region contexts and uses
`--no-lookups`, so a clean synth does not depend on ambient AWS discovery.
Review both generated templates. Required invariants include:

- three `PAY_PER_REQUEST`, KMS-encrypted DynamoDB tables with PITR;
- one private, KMS-encrypted, versioned Object Lock bucket;
- two KMS-encrypted work queues, two KMS-encrypted DLQs, and redrive policies;
- two SQS event-source mappings with partial-batch failure reporting and
  concurrency `2`;
- a 256 KiB message ceiling on both work queues, JSON Lambda system logs at
  `WARN`, and Powertools application logs filtered at `INFO`;
- one encrypted EventBridge bus and bounded ingestion route;
- one stateful non-empty alarm per DLQ, with both ALARM and OK actions;
- 90-day logs, active tracing, bounded timeouts, and SQS event-source maximum
  concurrency `2`; all functions deliberately use the account's unreserved
  pool so low-quota assessment accounts retain Lambda's required unreserved
  capacity;
- private-S3 CloudFront origin, a default-behavior-only viewer-request rewrite
  for extensionless UI navigation, non-cached API/MCP behaviors, and the
  security-header policy; there is no distribution-wide custom error response
  that could turn an API/MCP or missing-asset error into `index.html` with 200;
- no OpenSearch resource and no credential value.
- the three production ingestion lookup GSIs, the exact connector/version
  allowlist with no `demo` source, secret/key ARN references, and no wildcard
  worker data-plane policy resource.
- retrieval writer/reader items use the canonical secret-independent
  `retrievalDynamoKeyV1` scope partition rather than the canonical-ingestion
  digest `KeyCodec`, and ingestion can perform the bounded consistent `Query`
  required to enumerate registered staging;
- authorization uses an independent monotonic epoch item, epoch-qualified
  staging/query keys, consistent epoch reads, and a transactional epoch
  `ConditionCheck` plus head CAS;
- API/MCP environment bindings select the durable core/retrieval/snapshot
  composition and credential-free product URL rather than fixture services;
- API/MCP retrieval-table permissions are read-only because both produce the
  validated deterministic query vector in process; only API can enqueue the
  approval operation.

## Deploy an exact snapshot

Deployment is performed only by the parent workflow from a reviewed committed
snapshot. Record the commit SHA before deployment and do not deploy a dirty
worktree.

```powershell
git status --short
git rev-parse HEAD
pnpm build
pnpm --filter @chief/infra-cdk build

Push-Location infra/cdk
pnpm exec cdk diff ChiefProductStack ChiefFoundationStack `
  --app "node --enable-source-maps dist/bin/app.js" `
  --context account=417242953053 `
  --context region=us-east-2 `
  --profile $ChiefAwsProfile

pnpm exec cdk deploy ChiefProductStack ChiefFoundationStack `
  --app "node --enable-source-maps dist/bin/app.js" `
  --context account=417242953053 `
  --context region=us-east-2 `
  --profile $ChiefAwsProfile `
  --require-approval never
Pop-Location
```

When the three production ingestion GSIs are new to an existing table, AWS
permits only one GSI creation or deletion per table update. Deploy the product
stack in three resumable waves before the final full-stack command above:

```powershell
foreach ($Stage in 1..3) {
  pnpm exec cdk deploy ChiefProductStack `
    --app "node --enable-source-maps dist/bin/app.js" `
    --context account=417242953053 `
    --context region=us-east-2 `
    --context ingestionGsiStage=$Stage `
    --profile $ChiefAwsProfile `
    --require-approval never
}
```

Each wave is monotonic: stage 1 adds `ThreadLookupIndex`, stage 2 adds
`IdentityLookupIndex`, and stage 3 adds `AsanaTopicLookupIndex`. The default is
stage 3, so normal synths and every later deployment retain the complete
ingestion schema. Do not skip directly to stage 3 when more than one of these
indexes is absent.

`--require-approval never` suppresses only the CDK CLI prompt; it does not
weaken the repository's human authorization rules. The exact deployment action
must already be authorized.

## Outputs and smoke checks

Capture output values without printing secret contents:

```powershell
$Foundation = aws cloudformation describe-stacks `
  --stack-name ChiefFoundationStack `
  --profile $ChiefAwsProfile `
  --region us-east-2 | ConvertFrom-Json

$Product = aws cloudformation describe-stacks `
  --stack-name ChiefProductStack `
  --profile $ChiefAwsProfile `
  --region us-east-2 | ConvertFrom-Json

$Foundation.Stacks[0].Outputs | Select-Object OutputKey, OutputValue
$Product.Stacks[0].Outputs | Where-Object OutputKey -notmatch 'Secret' |
  Select-Object OutputKey, OutputValue
```

Use the `WebUrl`, `ApiHealthUrl`, `McpHealthUrl`, `CloudFrontApiUrl`, and
`CloudFrontMcpUrl` outputs for smoke tests. A clean signed-out browser must load
the web URL and survive direct deep-link refresh. API and MCP health must return
HTTP 200. The CloudFront response must include the committed CSP,
`X-Content-Type-Options`, frame denial, referrer policy, HSTS, and permissions
policy. A direct UI route such as `/inbox/thread-q3-launch` must serve the SPA,
while an unknown `/trpc/...`, unknown `/mcp/...`, and missing asset with a file
extension must retain their origin error status and must not return HTML 200.

Record evaluator endpoints as deployment outputs. The current assessed release
uses:

- UI: `https://d3hgq3e86d3knk.cloudfront.net`
- API base: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com`
- API health: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com/trpc/system.health`
- MCP endpoint: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com/mcp`
- MCP health: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com/mcp/health`

For a later release, read these values again from the matching
`ChiefFoundationStack` outputs rather than assuming the current hostnames remain
authoritative.

Then run the strict hosted suite. Each value must be a deployed, credential-free
HTTPS origin/base URL; the configuration rejects missing URLs,
single-label/private/local/reserved/unspecified hosts, non-public IPv4/IPv6
ranges, URL credentials, query strings, and fragments. There is no
configuration path that skips a hosted-safe check; two mock-dependent
fixture-only scenarios remain explicitly excluded from the runnable hosted
selection.

```powershell
$env:CHIEF_BASE_URL = '<ChiefFoundationStack.WebUrl>'
$env:CHIEF_API_BASE_URL = '<ChiefFoundationStack.ApiUrl>'
$env:CHIEF_MCP_BASE_URL = '<ChiefFoundationStack.ApiUrl>'
pnpm --filter @chief/e2e test:hosted
```

The hosted suite has no local web server. It requires the durable hosted banner,
confirms the draft body is read-only, invokes **Create
concise revision**, approves that exact immutable successor, captures its
effect-disabled operation receipt, reloads the page, and confirms the same
proposal/operation through API status. It also performs MCP
`initialize`, `tools/list`, and `tools/call` against the deployed MCP
composition, calls `get_approval_status` with the browser proposal ID, requires
structured content equal to the API's approved proposal status, and asserts
that approval/send tools are absent.

Also verify:

- both DLQs are empty;
- both event-source mappings are enabled;
- the ingestion mapping reports partial batch failures and maximum concurrency
  `2`; both workers use the account's unreserved pool so Lambda can preserve its
  mandatory unreserved minimum;
- a deliberately malformed, fixture-mode, wrong-authority, or wrong connector
  version queue record is returned in `batchItemFailures` and produces no
  canonical write;
- all four effect switches are `disabled` on all four Lambdas;
- API access logs and Lambda log groups retain 90 days;
- the public UI shows seven account-scoped fixture connector cards plus
  capability-mode definitions, reports zero hosted recorded/blocked evidence
  without rendering unavailable cards, and never claims signed-out OAuth/account
  setup;
- the evaluator identity marker, approval/execution state, and current retrieval
  head are durable and contain only approved deterministic non-PII data; inbox
  rows and connector cards are regenerated from the source-owned V2 corpus;
- **Create concise revision** sends the exact bounded instruction, produces a
  different, shorter immutable revision 2 with unchanged citations/factual
  count and passed validation, then prepare -> approve creates only an
  `effect_disabled` receipt; a route reload returns the same revision, proposal,
  operation ID, and receipt;
- MCP `initialize -> tools/list -> tools/call` reaches the durable shared
  service rather than a fixture-only MCP service and returns the same approved
  proposal created through the browser/API;
- repeated legacy MCP `submit_for_approval` calls fail with the same stable
  `TOOL_UNAVAILABLE` result and cannot create approval state;
- no unauthenticated request exposes a tenant selector, provider endpoint,
  credential, raw table/path authority, or direct effect tool.

Hosted provider, Asana, model, and authenticated MCP acceptance remain separate
deployment-dependent checks. A successful deterministic evaluator test is not
evidence of a live provider effect.

For the current assessed release, the parent workflow deployed an exact clean
snapshot, reseeded the synthetic scope through the production
register/enumerate/compact/promote path, and completed strict hosted acceptance
with 19 runnable checks passed, 2 fixture-only checks skipped, and 0 failures.
Those results prove the deterministic effect-disabled evaluator vertical, not
provider authentication, live provider delivery, or an Asana mutation.

## Operations and recovery

The two DLQ alarms publish state transitions to `RuntimeAlertTopicArn`. The SNS
topic policy permits only account-bound CloudWatch alarm publication, and the
customer-managed key permits the SNS service to decrypt/generate data keys only
for the exact topic ARN and encryption context. Attach approved
email/chat/PagerDuty subscriptions through the operator workflow; no
destination or routing key is embedded in the template. A non-empty DLQ moves
the alarm to ALARM once, and draining/redriving it returns the alarm to OK so
the incident can self-resolve.

For a failed release, redeploy the prior reviewed commit. Do not rename or
delete runtime exports while the foundation stack imports them. Do not redrive
the outbox DLQ until the approval, attempt, ambiguity, idempotency, and current
effect-switch state have been reviewed.

The data tables, KMS key, web bucket, and immutable snapshot bucket are retained
by policy. The snapshot bucket uses 365-day compliance Object Lock, so stack
deletion is not a data-erasure mechanism and may leave retained resources. Any
teardown must inventory exact retained resources and follow the approved
retention/deletion workflow.

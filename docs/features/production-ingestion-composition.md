# Production ingestion composition

Status: implemented as a fail-closed AWS Lambda composition.

## Outcome

The deployed ingestion entry point now consumes bounded SQS batches instead of
exporting the in-memory fixture pipeline. It accepts only EventBridge envelopes
from the internal `chief.connectors` ingestion route, verifies a
`server_grants` authority snapshot against every work item, admits only a
deployment-owned connector ID/version/mode binding, and then runs the existing
canonical ingestion pipeline.

Production composition uses the existing boundaries:

- connector snapshots from the connector SPI remain the immutable provider,
  account, descriptor, capability, selection, and runtime-mode evidence;
- `DynamoPersistence` and `DynamoRepositoryIngestionStore` persist canonical
  facts, outbox facts, quarantine facts, and fenced checkpoints;
- encrypted, versioned S3 objects store normalized bodies and factual retrieval
  deltas by content hash;
- `RetrievalMutationSink` creates the immutable delta manifest; and
- `RetrievalIndex.applyDelta` durably and idempotently registers that manifest
  in the retrieval table for the bounded retrieval runtime.

The composition performs no provider request, credential lookup, send, or
Asana mutation. `externalProviderCalls` therefore remains exactly `0`. It does
not claim that a registered connector has live provider behavior; a connector
owner must produce and authorize the fetched record before this boundary.

## Runtime flow

```text
SQS batch (maximum 10)
  -> strict EventBridge source/detail-type check
  -> server-grant tenant/account/brand/epoch/scope binding
  -> deployment-owned source -> connector ID/version/mode admission
  -> canonical pipeline validation and normalization
  -> encrypted immutable S3 body and retrieval-delta writes
  -> Dynamo canonical fact + event outbox + fenced checkpoint
  -> durable retrieval-manifest registration
  -> SQS partial-batch response
```

One poison SQS record returns only its `messageId` in
`batchItemFailures`; successful sibling records are not redriven. Inside an
accepted ingestion event, the existing pipeline still quarantines individual
poison work items and continues the bounded invocation.

Each invocation publishes the bounded, dimension-free `RecordIngested`,
`RecordFailed`, and `ProcessingDuration` Powertools metrics. Logs contain only
source enum values and aggregate counts, never caller-controlled identifiers,
provider payloads, message text, identities, credentials, or object contents.

## Ingress contract

SQS message bodies must be EventBridge envelopes with:

- `source: chief.connectors`;
- `detail-type: communication.ingest.requested`; and
- `detail.schemaVersion: 1`.

`detail.authority` contains only server-derived authority:

```json
{
  "derivation": "server_grants",
  "tenantId": "tenant-a",
  "accountIds": ["gmail-account"],
  "brandIds": ["brand-a"],
  "authorizationEpoch": 3,
  "scopeHash": "<lowercase-sha256>"
}
```

`detail.ingestionEvent` is the existing `IngestionEvent`. Every work item must
match the authority tenant, an admitted account, a subset of admitted brands,
the exact authorization epoch, and the exact scope hash. The raw object tenant,
connector snapshot account, source discriminant, and checkpoint account/tenant
are then revalidated by the canonical pipeline. Queue IAM is the producer
boundary; there is no anonymous HTTP route or caller-selected tenant.

## Deployment configuration

All variables below are mandatory. Missing, blank, malformed, or fixture
configuration rejects initialization; production never falls back to memory.

| Variable                                  | Purpose                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `INGESTION_RUNTIME_MODE=production`       | Explicitly selects the deployed composition                  |
| `CORE_TABLE_NAME`                         | Canonical facts and event outbox                             |
| `CONNECTOR_RUNTIME_TABLE_NAME`            | Checkpoints and quarantine facts                             |
| `RETRIEVAL_TABLE_NAME`                    | Immutable retrieval-manifest registrations                   |
| `SNAPSHOT_BUCKET_NAME`                    | Encrypted immutable bodies and retrieval deltas              |
| `DIGEST_KEY_SECRET_ARN`                   | Secrets Manager reference to `{version,key}` digest material |
| `PRODUCT_DATA_KEY_ARN`                    | KMS key reference used for S3 writes and evidence            |
| `INGESTION_THREAD_LOOKUP_INDEX_NAME`      | Tenant-bound thread chronology query index                   |
| `INGESTION_IDENTITY_LOOKUP_INDEX_NAME`    | Tenant-bound keyed identity candidate index                  |
| `INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME` | Tenant-bound Asana topic candidate index                     |
| `INGESTION_CONNECTOR_BINDINGS`            | Server-owned source-to-connector snapshot allowlist          |

The frozen connector binding is:

```text
gmail=gmail@1.0.0,microsoft_graph=microsoft-graph@1.0.0-wave1a,imap=imap-smtp@1.0.0-protocol,twilio_sms=twilio-sms@1.0.0,twilio_whatsapp=twilio-whatsapp@1.0.0,x=x_legacy_dm@1.0.0,linkedin_archive=linkedin-communications@1.0.0-scaffold,asana=asana-work-management@1.0.0
```

Production admits only the truthful source-specific modes: Gmail, Graph, IMAP,
X, and Asana `live`; Twilio SMS `live_trial`; Twilio WhatsApp `sandbox`; and
LinkedIn archive `manual`. `fixture`, `virtual_test`,
`blocked_external_access`, and `disabled` snapshots are rejected. `demo` is
never a production source. X is version-registered for evolution but cannot
produce accepted work until its connector snapshot truthfully reaches `live`.

## Fixture and evaluator boundary

`createFixtureIngestionHandler()` remains an explicit credentialless test/demo
factory. It uses fresh in-memory persistence, deterministic digest material,
and a recording retrieval index. Tests prove two fresh fixture compositions
produce the same result and make zero provider calls.

The exported Lambda `handler` is production-only and lazy-loads AWS
configuration and digest material. The public evaluator API remains a separate
fixed-tenant, effect-disabled surface; it neither invokes this worker with
anonymous authority nor gains provider credentials or provider-send
capability.

## Persistence and recovery tradeoffs

S3 writes use a tenant-partitioned content-hash key, `If-None-Match: *`, a
SHA-256 checksum, KMS encryption, and the bucket's versioning/Object Lock
policy. Exact replay reuses the immutable object instead of overwriting it.
Canonical fact and event-outbox persistence still precede checkpoint advance.

The ingestion worker registers immutable retrieval deltas; it does not perform
query hydration or silently create an empty snapshot head. Until the bounded
retrieval compactor publishes a valid snapshot generation, query health remains
`INDEX_REFRESH_REQUIRED`. This is deliberately fail-closed and truthful: a
durable delta is not mislabeled as a query-ready RAG corpus.

The package now declares direct AWS SDK dependencies because production
composition owns those clients. The workspace lockfile is outside this lane's
ownership and must be refreshed by the parent integration owner with exact
pnpm `10.33.0` before a frozen-lockfile install.

The shared `@chief/observability` factory currently hardcodes the
`ChiefFoundation` metric namespace even when infrastructure supplies
`POWERTOOLS_METRICS_NAMESPACE=ChiefProduct`. Changing that shared package is
outside this lane; parent integration must make the factory honor the supplied
namespace and add its package-level regression test.

## Verification

Under Node `22.18.0` and pnpm `10.33.0`:

```powershell
corepack pnpm --filter @chief/ingestion-worker lint
corepack pnpm --filter @chief/ingestion-worker typecheck
corepack pnpm --filter @chief/ingestion-worker test
corepack pnpm --filter @chief/ingestion-worker build
```

The focused tests cover complete and incomplete deployment configuration,
fixture-mode rejection, connector-map corruption, tenant/account/scope/epoch
substitution, unregistered connector and fixture snapshot rejection, partial
batch redrive, and deterministic credentialless fixture operation.

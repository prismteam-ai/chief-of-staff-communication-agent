# Canonical ingestion and linking

Status: implemented in Chief Wave 2A.

## Outcome

The ingestion worker now executes a deterministic, networkless normalization
pipeline over connector-shaped fetch results. It preserves the immutable raw
reference, creates frozen canonical message/thread/participant/attachment
records, derives a conservative authored segment, reduces answered/SLA state,
emits candidate-only cross-channel links, and stages a bounded retrieval delta.
The delta reference, canonical fact, and event-outbox recovery signal commit
before projection application, while the fenced sync checkpoint advances only
as part of the successful canonical store operation.

The Lambda entry point returns aggregate and per-source counts for created,
updated, duplicate, deleted, quarantined, checkpointed, and retrieval-updated
records. It reports `complete`, `partial`, or `failed`, and always reports
`externalProviderCalls: 0`. Provider polling, credential access, webhook
verification, and live provider calls remain in the connector/provider lanes.

## Runtime composition

```text
typed connector-shaped work item
  -> account/tenant/snapshot/raw-reference/checkpoint validation
  -> source normalization
  -> attachment admission limits
  -> immutable IDs, keyed identity/provider digests, and body blobs
  -> authored-segment derivation (full body is always retained)
  -> message/thread/attachment and answered/SLA reduction
  -> tenant-scoped identity/topic/Asana candidate links
  -> retrieval delta staging
  -> canonical fact + delta reference + domain-event outbox commit
  -> fenced checkpoint advance
  -> RetrievalIndex.applyDelta for newly committed facts only
  -> per-source result
```

`CanonicalIngestionPipeline` depends on four reusable boundaries:

- `IngestionStore` for immutable bodies, bounded candidate lookups, chronology,
  canonical/event commits, checkpoint state, and quarantine;
- the frozen `KeyCodec` for tenant-bound, purpose-separated keyed digests;
- `RetrievalMutationSink` for authorization-scoped factual upsert/delete
  deltas;
- the frozen `RetrievalIndex` interface for applying those deltas.

`DynamoRepositoryIngestionStore` composes the existing
`DynamoPersistence` repository. It writes each immutable canonical revision and
event-outbox record together, then performs the fenced checkpoint update. If a
worker crashes after the immutable transaction but before checkpoint advance,
replay sees the immutable conflict as a duplicate and retries only the
checkpoint. A stale checkpoint epoch cannot skip new canonical work.

Projection application happens only after `commit` returns successfully and
never runs for a duplicate. If projection application fails, canonical truth,
the staged manifest reference, recovery event, and checkpoint remain committed.
The invocation reports a projection failure and queued recovery without
quarantining the already-committed record. The recovery consumer calls
`recoverProjection` with the exact stored manifest; ordinary duplicate replay
does not derive or apply a second delta and cannot advance the checkpoint twice.

`InMemoryIngestionStore` and `RecordingRetrievalIndex` implement the same
contracts for deterministic fixtures, resets, and fully networkless tests.
The exported default `handler` is explicitly this credentialless fixture
runtime. A live deployment must compose `createIngestionHandler` with the
Dynamo store, deployment-owned keyed-digest material, immutable encrypted body
writer, and deployed bounded retrieval adapter. The fixture handler never
claims live persistence or provider behavior.

## Supported source records

| Source           | Accepted record                                                                             | Truthful behavior                                                            |
| ---------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Gmail            | fetched message ID/thread, millisecond timestamp, headers, text/HTML, labels, attachments   | Normalizes existing connector fetch output; performs no Gmail call           |
| Microsoft Graph  | immutable message/conversation IDs, recipients, text/HTML body, attachments, removed marker | Normalizes Graph-shaped records; performs no Graph call                      |
| Generic IMAP     | UIDVALIDITY/UID/mailbox/message ID, reply reference, MIME-derived bodies and attachments    | Preserves polling/restart identity; does not claim native provider threads   |
| Twilio SMS       | SID, endpoints, body/media, direction, revoke marker                                        | Canonical SMS record only; no Twilio mutation                                |
| Twilio WhatsApp  | SID, endpoints, body/media, direction, revoke marker                                        | Canonical WhatsApp record only; no template/window/send claim                |
| X                | event/conversation/participant IDs, direction and text                                      | Accepts official connector/fixture output; no entitlement or live-read claim |
| LinkedIn archive | importer-produced message/conversation/participant IDs, source row hash and attachments     | Archive import only; no inbox API or scraping claim                          |
| Asana            | task/project/milestone/comment identity, version, timestamp and payload fingerprint         | Produces factual knowledge/link candidates; never mutates Asana              |
| Demo/future      | stable IDs, arbitrary channel label, participants/body/attachments                          | Proves the connector-neutral extension seam                                  |

Each work item binds exactly one server-derived tenant, connector account,
connector snapshot, authorization epoch, scope hash, and immutable raw object.
Source and record discriminants must match. The raw object tenant and snapshot
account must match the work item. A caller cannot use record content to choose
another tenant or connector account.

## Determinism and replay

- Message IDs are deterministic from tenant, account, and provider message ID.
- Thread IDs are deterministic from tenant, account, and provider thread ID.
- Revision IDs bind the canonical content hash; exact replay is a duplicate,
  while a changed provider revision is a new immutable fact.
- Attachments bind message, provider attachment ID, and content hash.
- Keyed digests—not raw email, phone, handle, or provider IDs—enter canonical
  identity and provider-reference fields.
- Source chronology is ordered by provider timestamp and deterministic revision
  ID, so out-of-order delivery does not regress the thread head.
- Answer state compares the latest active inbound and outbound timestamps.
  Pending inbound work receives a five-minute deadline and becomes overdue only
  under the injected clock.
- Retrieval deltas and candidate links use stable source hashes/IDs. Replaying
  the same generated corpus after reset yields identical canonical hashes.

No provider timestamp is treated as trusted wall-clock authority outside the
source chronology. The worker uses its injected clock for ingestion, SLA
evaluation, and authored derivation.

## Authored segment and prompt-injection isolation

The versioned `authored-v1` parser recognizes English, Spanish, French, and
German reply markers, forwarded-message markers, quoted lines, and signatures.
It records byte offsets, locale markers, confidence, ambiguity reasons, parser
version, and full input-body hash.

The immutable provider body and full normalized body are always retained. A
reliable quote boundary keeps hidden quoted instructions out of the authored
segment. If history begins before any authored text or an instruction-like
payload lacks a reliable boundary, the parser fails toward the full body with
low confidence. Downstream triage can request context rather than silently
discarding evidence.

## Linking ownership

Identity matching uses only tenant-bound keyed digests and can propose a person
candidate across connector accounts within the same tenant. Topic terms are
deterministically normalized and can propose matching Asana objects. Every
generated `TopicLink` has `reviewState: candidate`; the ingestion worker never
creates a reviewed identity merge or an authoritative vector-only link.

This preserves the architecture invariant that reviewed `TopicLink` revisions
are the sole writable source of cross-channel relationships. Retrieval deltas
are derived projections, not a second relationship authority. Display name
alone never auto-merges people, and a same-looking identity in another tenant
has an unrelated keyed digest and cannot become a candidate.

## Failure, limits, and recovery

- A single poison record is quarantined with a reason code and a hash of the
  error detail; raw content, identities, and credentials are not logged.
- Other work items continue, producing a `partial` result.
- Attachment admission is capped at 25 files, 10 MiB per file, and 25 MiB
  total per message before canonical persistence.
- Duplicate immutable events converge without duplicate canonical records.
- Stale checkpoint compare-and-swap fails closed.
- Deleted, expunged, removed, or revoked records create deterministic tombstone
  work and retrieval delete deltas; they never become external effects.
- A retrieval profile/manifest rejection after canonical commit is surfaced as
  recoverable projection work; it does not roll back canonical truth, quarantine
  the record, or advance the checkpoint again.
- Tests contain no provider client, network response, token, `.config` read, or
  credential access.

## Verification coverage

The focused Vitest suite proves:

- one executable invocation covering Gmail, Graph, IMAP, SMS, WhatsApp, X,
  LinkedIn archive, Asana, and a generic future channel;
- useful per-source counts and zero provider network calls;
- deterministic replay, raw-reference preservation, and duplicate collapse;
- out-of-order chronology plus answered/SLA convergence;
- localized quote parsing and prompt injection hidden in quoted history;
- tenant/account isolation, candidate-only cross-channel identity links, and
  Asana topic candidates;
- partial poison handling, attachment limits, checkpoint fencing and restart
  races;
- commit failure never exposing a retrieval delta, duplicate replay never
  reapplying one, and post-commit projection failure remaining recoverable from
  the exact committed manifest without false quarantine or checkpoint drift;
- delete/revoke tombstones and deterministic reset hashes.

Focused commands, under Node `22.18.0`:

```powershell
corepack pnpm --filter @chief/ingestion-worker test
corepack pnpm --filter @chief/ingestion-worker lint
corepack pnpm --filter @chief/ingestion-worker typecheck
corepack pnpm --filter @chief/ingestion-worker build
```

## Tradeoffs

The ingestion worker deliberately consumes fetched provider records instead of
calling provider APIs. This keeps credentials, rate limits, and provider
side-effects in the connector owners and makes replay fully deterministic.

The bounded retrieval writer is a separate port from `RetrievalIndex` because
the frozen retrieval interface owns applying/querying already-authenticated
manifests, not authoring S3/DynamoDB mutations. This separation preserves the
promotion seam to OpenSearch without teaching ingestion about index internals.

Candidate linking favors false negatives: only exact keyed identity evidence
or shared deterministic topic terms can create a proposal, and every proposal
requires review. That is less automatic than vector merging, but it avoids
unsafe cross-person or cross-tenant joins.

# Changelog

## Unreleased

### Added

- Added the versioned `chief-retrieval.v1` durable staging, snapshot, head, and
  query-vector contract shared by production ingestion and bounded retrieval.
- Added deterministic, bounded compaction with duplicate replay handling,
  contiguous publication sequences, snapshot validation, stale-writer
  rejection, and tenant/scope/authorization-epoch CAS head promotion.
- Added the canonical secret-independent `retrievalDynamoKeyV1` seam for every
  durable retrieval producer/reader, separate from canonical ingestion's
  secret-backed digest `KeyCodec`.
- Added bounded consistent DynamoDB Query enumeration of registered staging and
  register-triggered compaction/CAS retry, so production registration produces
  a queryable promoted head without a separate fixture or parent compactor.
- Added an independent monotonic DynamoDB authorization-epoch authority;
  epoch-qualified staging/query keys; transactional epoch `ConditionCheck` plus
  head CAS; consistent reader rechecks; old-epoch denial; and fresh-snapshot
  promotion on epoch transition.
- Added snapshot-contained canonical evidence text/hash, citation labels, exact
  entity references, active/tombstoned state, and mutation ordinals; cross-head
  replay does not advance sequence, and older upserts cannot supersede a newer
  tombstone.
- Added focused compatibility coverage from the production staging writer
  through compaction, promoted-head health, persisted query vectors, bounded
  retrieval, and citations.
- Added durable hosted product composition over DynamoDB/S3 retrieval,
  repository-backed recommendations and immutable draft revisions, and a fixed
  deterministic non-PII evaluator projection.
- Added atomic draft persistence: the immutable revision, exact-revision lookup,
  and conditional draft-head compare-and-swap commit in one transaction.
- Added server-authorized draft approval, immutable approval/execution records,
  approval-outbox enqueueing, terminal effect-disabled receipts, and reloadable
  approval/execution status.
- Added canonical immutable-value conflict comparison and idempotent replay for
  recommendation, the exact current draft (including revision 2), proposal,
  approval, and receipt state.
- Added exact post-approval `prepareDraft` replay of the persisted approved
  proposal, action-plan binding, and approval timestamp.
- Added post-commit SQS recovery: an enqueue failure leaves approval readable,
  and retry re-enqueues the stable operation ID while returning the same
  effect-disabled receipt.
- Added API/MCP composition parity: non-test Lambda defaults use the shared
  durable `@chief/api` service, while tests use production-shaped in-memory
  adapters rather than the fixture-only public service.
- Added a stable `TOOL_UNAVAILABLE` result for the retained legacy MCP
  `submit_for_approval` name; the HTTPS product API remains the only exact-draft
  approval path.
- Added a read-only persisted draft body and the sole evaluator revision action,
  **Create concise revision**, which submits exactly `Make this draft concise
while retaining all cited facts.` before approve/receipt/reload; also added
  functional connection and evidence routes, truthful fixed-scope copy, and
  explicit local-fallback restrictions.
- Added a real durable-service regression proving revision 2 has a different,
  shorter body while preserving citations, factual-citation count, passed
  validation, and exact restart reload.
- Added a non-skippable `test:hosted` Playwright configuration that requires
  separate deployed UI, API, and MCP HTTPS URLs and exercises MCP
  `initialize`, `tools/list`, and `tools/call`.
- Added public-host validation for hosted URLs, including private/local/
  reserved/unspecified hostname and IP rejection, and hosted MCP proof of the
  same browser-created approval proposal.
- Established the reproducible Node 22.18.0, Corepack 0.34.6, pnpm 10.33.0,
  TypeScript 5.9.3, strict ESM/NodeNext Turborepo foundation.
- Added modular communication/provider contracts, durable persistence,
  bounded RAG, cited agent/draft generation, approval/outbox execution guards,
  typed tRPC/browser clients, remote MCP, responsive UI, Playwright E2E, and
  two-stack AWS CDK deployment.

### Changed

- Replaced fixture-only hosted API and MCP defaults with the durable product
  composition while retaining the deterministic fixed-scope evaluator data.
- Replaced the incompatible arbitrary-sequence retrieval delta with immutable
  staged mutations that compact into the exact NDJSON/binary32 snapshot format
  consumed by the existing bounded reader.
- Replaced React-local approval authority with exact-revision, server-derived,
  durable approval and status operations.
- Updated evaluator copy to define deterministic, recorded, blocked, and live
  capability modes without claiming public OAuth or account setup. The hosted
  deterministic seed exposes one fixture connector card; recorded and blocked
  remain definitions with zero hosted evidence, not additional cards.

### Safety boundaries

- Public API/MCP authority is fixed by the server; caller tenant, account,
  provider, storage, and credential authority is rejected.
- Public external effects, provider effects, work-management effects, and model
  effects remain disabled. A successful public approval records only an
  `effect_disabled` receipt.
- MCP has no approval or direct-effect tool. The browser local fallback cannot
  approve and is forbidden in strict hosted acceptance.
- This implementation lane did not deploy, seed AWS, call a provider, or run
  hosted acceptance. The parent workflow owns deployment and hosted proof.

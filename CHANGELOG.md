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

- Removed app-tier synthesis of the SEC-4821 Asana citation and synthetic
  retrieval-manifest hash. Public knowledge and agent citations now fail closed
  unless one unique retrieved candidate/evidence tuple matches the citation's
  source, chunk, version, authorization epoch, and evidence-text hash; genuine
  indexed Asana evidence remains eligible.
- Removed evaluator-only Asana identity/text and legacy communication/Asana
  source-class upgrades from the durable product service and its memory
  retrieval composition. Related Asana work there remains empty until
  source-owned durable evidence exists; the separate legacy fixture service is
  unchanged by this patch.
- Added a fail-closed manifest-proof capability to the retrieval port. A source
  adapter must verify the exact tenant/scope/epoch/role/scoring/manifest binding
  and issued source/chunk/version/epoch/evidence rows; a 64-hex string alone is
  rejected. The AWS composition now rechecks the bounded index's active stable-
  epoch manifest and rejects altered or non-issued results.
- Added read-time citation-lineage revalidation for persisted recommendations
  and drafts before replay, revision, context/Asana handoff, or approval
  preparation. Legacy artifacts containing absent or untrusted citations are
  quarantined with `STALE_REVISION` instead of being returned by ID.
- Extended that quarantine to proposal replay, approval, approval status,
  and execution status. A persisted proposal must still resolve through its
  exact draft and current trusted recommendation to the same deterministic
  action plan before it can be returned, approved, or queued. Passive dashboard
  counts omit lineage-stale historical proposals so quarantine cannot make the
  healthy corpus unavailable; malformed indexes, missing indexed state, and
  non-stale authority errors still fail closed.
- Recalibrated the documented confidence heuristic so one model-selected,
  source-owned cited fact with no missing facts reaches the unchanged `0.67`
  action threshold. Zero evidence, missing facts, unsupported fact IDs, prompt
  injection, and model degradation still abstain or fail closed.
- Strengthened hosted acceptance to require an empty related-Asana result and
  no Asana/SEC-4821 citation when the durable corpus contains none, while
  proving the genuine communication citation is identical across API and MCP.
- Replaced fixture-only hosted API and MCP defaults with the durable product
  composition while retaining the deterministic fixed-scope evaluator data.
- Replaced the incompatible arbitrary-sequence retrieval delta with immutable
  staged mutations that compact into the exact NDJSON/binary32 snapshot format
  consumed by the existing bounded reader.
- Replaced React-local approval authority with exact-revision, server-derived,
  durable approval and status operations.
- Updated evaluator copy to define deterministic, recorded, blocked, and live
  capability modes without claiming public OAuth or account setup. The hosted
  deterministic seed exposes seven source-owned connector cards: six fixture
  cards and one manual/recorded LinkedIn archive card. Blocked remains a mode
  definition with zero hosted evidence and does not create an additional card.

### Safety boundaries

- Public API/MCP authority is fixed by the server; caller tenant, account,
  provider, storage, and credential authority is rejected.
- Public external effects, provider effects, work-management effects, and model
  effects remain disabled. A successful public approval records only an
  `effect_disabled` receipt.
- Controlled real-effect, reconciliation, and feedback-closure paths are
  library contracts with automated tests only. No durable reconciliation or
  feedback-closure adapter is wired into the deployed Lambda composition; the
  public worker uses the effect-disabled sink.
- MCP has no approval or direct-effect tool. The browser local fallback cannot
  approve and is forbidden in strict hosted acceptance.
- The parent workflow deployed and verified commit
  `57660f3f22d2cc2c93ebe4f9659ebacf8ad1f867`. Both stacks are
  `UPDATE_COMPLETE`; the deterministic retrieval seed returned
  `already_current`; dashboard metrics returned HTTP 200; and strict hosted
  acceptance passed 19 runnable checks with 2 fixture-only skips and 0 failures.

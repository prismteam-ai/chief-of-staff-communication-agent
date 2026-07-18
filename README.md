# Chief of Staff Communication Agent

Chief is a reusable, multi-channel communication workflow that turns bounded,
tenant-scoped evidence into cited recommendations and drafts, requires an exact
immutable revision for approval, and records a durable execution outcome. The
public evaluator uses deterministic non-PII data and the production storage
shapes while all provider, work-management, model, and external effects remain
disabled.

## Durable evaluator vertical

```text
connector-shaped event
  -> canonical ingestion + immutable `chief-retrieval.v1` staged mutation
  -> register + bounded DynamoDB Query catalog enumeration
  -> deterministic compaction + validated CAS snapshot-head promotion
  -> profile-bound query vector + bounded DynamoDB/S3 retrieval + citations
  -> recommendation -> draft -> immutable revised draft
  -> server-authorized approval -> durable approval/execution records
  -> terminal `effect_disabled` receipt -> reload/status
```

The hosted API and MCP Lambda entry points default to the durable AWS
composition outside tests. Both use the same `@chief/api` product service,
fixed server-derived evaluator authority, DynamoDB revision/head records, and
bounded DynamoDB/S3 retrieval path. They do not default to the old fixture-only
product or MCP services.

The deterministic evaluator projection is regenerated from the source-owned V2
corpus when the product service starts. The durable product repository stores a
small identity/integrity marker plus approval and execution state; it does not
store all 1,120 inbox rows or seven connector cards. The projection contains no
private archive or provider credential and is clearly labeled as non-live. The
local browser fallback remains useful for UI development, but it
cannot approve anything and is rejected by the strict hosted acceptance suite.

## Retrieval contract

`chief-retrieval.v1` is the only durable writer/reader format:

- retrieval storage uses canonical, secret-independent
  `retrievalDynamoKeyV1` keys shared literally by writers and readers; the
  secret-backed canonical-ingestion `KeyCodec` remains a separate concern;
- each tenant/scope/role domain has an independent monotonic DynamoDB
  authorization-epoch item; staging and persisted query-vector entity keys are
  epoch-qualified even though the domain/head key remains stable;
- ingestion writes immutable, content-addressed staged upserts or tombstones
  containing canonical evidence text, content hash, citation label, exact
  entity references, authorization state, mutation ordinal, and binary32
  vector;
- registration durably catalogs the manifest, enumerates that scope with
  bounded, consistent DynamoDB Query pages, and triggers compaction with
  bounded CAS retry;
- compaction deduplicates replay by mutation ID, orders changes
  deterministically, applies only newer ordinals to the validated base head,
  and emits the exact NDJSON projection plus `binary32-le-row-major` vector
  objects consumed by the bounded reader;
- the new manifest is read-validated before a tenant/scope/role/authorization-
  epoch-scoped compare-and-swap promotes the head; one DynamoDB transaction
  condition-checks the independent current epoch and performs the head CAS;
- published sequences remain contiguous; replay across a later head with no
  applied change returns that head unchanged and does not advance sequence;
- tombstones stay in the snapshot and their mutation ordinal prevents an older
  upsert from resurrecting deleted evidence;
- a stale writer, foreign scope, corrupt object, conflicting equal ordinal,
  invalid manifest, or exceeded item/byte/RSS bound fails closed;
- query vectors use the same deterministic effect-disabled embedding profile;
  the package supports scoped persisted vectors for replay/compaction proof,
  while API/MCP produce the validated vector in process and keep retrieval IAM
  read-only;
- health remains unavailable until a readable validated head exists.

The bounded reader derives exact-match eligibility, active/tombstoned state,
citations, and canonical evidence text from the validated scoped snapshot while
consistently reading and rechecking the independent authorization epoch before
and after snapshot/query work. Once the epoch advances, old-epoch reads fail;
only a freshly promoted snapshot for the new epoch becomes readable. Durable
communication evidence retains that promoted manifest hash. For the fixed
launch evaluator only, the product combines it with the explicitly related
deterministic SEC-4821 Asana fixture citation under a versioned relation hash;
it does not represent that combined hash as a raw retrieval manifest or a live
Asana read.

The focused compatibility suite runs the actual production staging writer into
compaction, CAS promotion, persisted query-vector production, bounded
retrieval, and citations. The durable API suite then proves cited
recommendation/draft creation on the same retrieval interface.

## Approval and effect boundary

The persisted draft body is read-only in the evaluator. Its sole revision
control is **Create concise revision**, which submits exactly `Make this draft
concise while retaining all cited facts.` and persists an immutable successor
before approval becomes available. `approvals.prepareDraft` binds a proposal
and action-plan hash to that exact revision. Creating or revising a draft
atomically writes the immutable revision, its exact-revision lookup, and the
conditionally advanced draft head in one DynamoDB transaction; a failed head
compare-and-swap cannot leave a visible head without its lookup.
`approvals.approve` accepts only the server-authorized proposal plus its
expected update timestamp, builds the immutable approval bundle, and advances
the proposal head together with operation locator, aggregate, and authority
records in DynamoDB. When configured, the operation ID is also placed on the
approval-outbox queue.

Recommendation, draft, proposal, and approval replay returns the persisted
winner rather than generating a new timestamp. In particular, calling
`createDraft` after revision 2 exists reloads that exact persisted revision 2.
Duplicate immutable records are accepted only when canonical hashes of the
complete stored values match; a same-key/different-value replay is a conflict.
After approval, replaying `approvals.prepareDraft` returns that same persisted
proposal as `approved`, including its exact action-plan binding and approved
timestamp.

The public execution policy is permanently `effect_disabled`. Approval settles
a durable receipt containing the operation ID, artifact hash, stable
idempotency key, and observation time. Reload uses `approvals.status` and
`execution.status` to return the same approval and receipt. No provider request,
Asana mutation, model call, or credential access is represented as successful
execution.

SQS delivery occurs after the approval transaction. If enqueueing fails, the
approved receipt remains readable; retrying approval re-enqueues the same stable
operation ID and returns the same receipt without creating a new approval.

MCP remains read/draft/status only for the exact approval ceremony. It can
retrieve evidence, recommend, draft, revise, request context, prepare an Asana
handoff, and poll approval status; the product API owns persisted-draft
preparation and approval. MCP has no approve, send, create-task, or update-task
tool. The retained legacy `submit_for_approval` name fails deterministically
with `TOOL_UNAVAILABLE`; it is not an alternate approval route.

`submit_for_approval` is retained only as a deprecated compatibility stub for
older MCP clients. Its `tools/list` description says that it is unavailable,
directs users to the HTTPS product draft-approval flow, and states that no
effect is executed. Every call fails with the stable `TOOL_UNAVAILABLE` code;
it cannot approve, send, create a task, or update a task.

## Evaluator walkthrough

1. Open `/overview`; confirm the signed-out, deterministic, non-PII and
   effect-disabled labels and inspect SLA/channel metrics.
2. Open `/connections`; inspect the seven account-scoped fixture connector cards
   and the capability-mode definitions. Recorded and blocked both show zero
   evidence in the deterministic seed, so no recorded or blocked connector card
   is expected. This evaluator does not offer OAuth or account setup.
3. Open `/inbox/thread-q3-launch`; inspect the thread, related Asana reference,
   cited recommendation, style-grounded draft, and focused-context action.
4. Confirm the persisted draft body is read-only, then choose **Create concise
   revision**. Verify revision 2 has a different, shorter body while retaining
   the same citations, factual-citation count, and passed validation.
5. Approve the prepared exact revision. Confirm the durable
   `effect_disabled` receipt and record its proposal and operation IDs.
6. Reload the route. Confirm both IDs and the same receipt remain visible.
7. Open `/evidence`; follow the fixed-scope Cursor/MCP instructions and verify
   `initialize -> tools/list -> tools/call`. Use `get_approval_status` with the
   browser proposal ID and confirm MCP returns the same approved proposal.
   Confirm no direct-effect tool is listed.

## Local verification

Use Node `22.18.0` and pnpm `10.33.0`:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm install --frozen-lockfile

pnpm --filter @chief/rag test
pnpm --filter @chief/ingestion-worker test
pnpm --filter @chief/api test
pnpm --filter @chief/mcp test
pnpm --filter @chief/web test
pnpm --filter @chief/e2e typecheck
pnpm --filter @chief/e2e test

pnpm format:check
pnpm lint
pnpm verify:force
pnpm --filter @chief/infra-cdk synth
node tools/secret-policy/self-test.mjs
node tools/secret-policy/scan.mjs --repo . --format text
git diff --check
```

The ordinary E2E configuration may use the explicitly labeled local fallback.
It does not count as hosted proof.

## Strict hosted acceptance

The hosted command requires three credential-free HTTPS deployment URLs. It
rejects missing values, single-label/private/local/reserved/unspecified hosts,
non-public IPv4/IPv6 ranges, URL credentials, query strings, and fragments. It
has no local web server or configuration path that skips a hosted-safe check;
the two mock-dependent fixture-only scenarios remain explicitly excluded from
the runnable hosted selection.

```powershell
$env:CHIEF_BASE_URL = 'https://<parent-deployment-web-host>'
$env:CHIEF_API_BASE_URL = 'https://<parent-deployment-api-host>'
$env:CHIEF_MCP_BASE_URL = 'https://<parent-deployment-mcp-host>'
pnpm --filter @chief/e2e test:hosted
```

Expected parent deployment outputs:

- UI: `<ChiefFoundationStack.WebUrl>`
- API health: `<ChiefFoundationStack.ApiHealthUrl>`
- MCP endpoint: `<ChiefFoundationStack.McpUrl>`
- MCP health: `<ChiefFoundationStack.McpHealthUrl>`

The assessed `2ad8432a8c8a48f9e2e5d3864944eb7541d2c500` release is live at:

- UI: `https://d3hgq3e86d3knk.cloudfront.net`
- API base: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com`
- API health: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com/trpc/system.health`
- MCP endpoint: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com/mcp`
- MCP health: `https://prjip3os8i.execute-api.us-east-2.amazonaws.com/mcp/health`

Both CloudFormation stacks are `UPDATE_COMPLETE`. The strict hosted suite
finished with **19 runnable checks passed, 2 fixture-only checks skipped, and 0
failed**. The runnable selection contains 18 network/product checks plus one
interception guard; hosted mode refuses to install the mocks used by the two
local fixture-only scenarios.

## Capability scope

The repository includes modular Gmail, Microsoft Graph, IMAP/SMTP, Twilio
SMS/WhatsApp, X, LinkedIn archive-import, and Asana contracts and adapters;
canonical ingestion/linking; bounded RAG; style-aware cited agents; durable
approval/outbox and execution guards; tRPC/browser clients; remote MCP; CDK;
and responsive evaluator UI/E2E coverage. These code-level adapters are not a
claim that the public runtime has authenticated or certified those providers.
Public capability labels distinguish deterministic data, recorded evidence,
and authorization-blocked providers. The V2 evaluator seed defined by this
revision contains 1,120 synthetic primary messages in 160 threads across seven
account-scoped fixture channels/connectors and two brands. It does not claim
completed Gmail operator consent, live provider send, Twilio sender
certification, or live Asana mutation evidence. Recorded and blocked modes have
zero hosted evidence and do not produce connector cards.

The private LinkedIn archive is not imported, exposed, or required by this
public vertical. Live provider authentication and external-effect acceptance
remain separate operator-controlled workflows.

## Documentation

- [Typed product API](docs/features/product-api.md)
- [Cursor-accessible MCP](docs/features/cursor-mcp.md)
- [`chief-retrieval.v1` storage and deployment](docs/operations/aws-deployment.md)
- [Effect execution invariants](docs/features/effect-execution.md)
- [Credential ingress](docs/operations/credential-ingress.md)

## Team Kit provenance

The implementation reuses the Soofi XYZ Team Kit’s contract-first agent
routing, frontend-backend, AWS/CDK, RAG, approval, E2E, and read-only Slowking
review practices. Material implementation used `gpt-5.6-sol` with reasoning
level `high`; the parent workflow owns the final required read-only review.

## Reference

- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)

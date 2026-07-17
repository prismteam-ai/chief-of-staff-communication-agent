# Known limitations & follow-ups

Honest accounting of shortcuts taken to fit this delivery's scope/window, why each is acceptable
for a demo/assignment submission, and what the production fix looks like. None of these block the
demonstrated workflows; all are scoped, understood tradeoffs rather than oversights.

## 1. OIDC deploy role: reduced from `AdministratorAccess`, not yet fully least-privilege

`lib/constructs/github-oidc-deploy-role.ts` originally granted the GitHub Actions OIDC deploy role
the AWS managed `AdministratorAccess` policy. That was replaced (slowking-fixes batch) with an
inline policy scoped to the specific services `just deploy` touches, plus an explicit `Deny`
(`DenySelfModification`) that blocks the role from calling `iam:PutRolePolicy`/
`iam:AttachRolePolicy`/`iam:PutRolePermissionsBoundary`/`iam:DeleteRolePermissionsBoundary`/
`iam:CreatePolicyVersion`/`iam:DeleteRolePolicy` on ITS OWN role ARN — closing the one-call
self-escalation path a bare `role/*` Allow would otherwise leave open.

- **What's still not least-privilege:** the mutating IAM grants (`iam:PutRolePolicy`/
  `iam:AttachRolePolicy`/etc.), `iam:PassRole`, and `lambda:*` remain scoped to this account+region
  but NOT to a stable name prefix — every OTHER role in the account (not just this app's own
  Lambda/scheduler roles) technically matches `role/*`/`policy/*`, because none of this repo's
  `NodejsFunction`s set an explicit `functionName`/`roleName`, so CDK auto-generates unstable
  per-deploy names a prefix pattern can't target. The self-modification Deny closes the sharpest
  edge (this role escalating itself) but not the account-wide breadth of what it can otherwise
  touch.
- **Why acceptable here:** single-account, single-operator sandbox with no other tenants; the
  role's trust policy is still scoped to this one repo/branch via the OIDC subject condition, so
  only this codebase's CI can assume it, and it can no longer grant itself more power once assumed.
- **Production fix:** set explicit `${PROJECT_NAME}`-prefixed `functionName`/`roleName` on every
  `NodejsFunction`/execution role this app creates, then narrow the IAM/Lambda/PassRole statements
  to that prefix; add a permissions boundary requirement on every role this policy is allowed to
  create, so even the account-wide grants can only ever produce boundary-constrained roles.

## 2. `accounts-repo.listByUser` is a Scan with a filter expression

`apps/api/src/repos/accounts-repo.ts#listByUser` runs a full table `ScanCommand` with
`FilterExpression: 'userId = :userId'` instead of a Query.

- **Why acceptable here:** the accounts table has a handful of demo rows (one user, a few
  channels); a Scan costs nothing meaningful at this scale and every other read path in the repo
  already uses `GetCommand` by primary key.
- **Production fix:** add a `byUser` GSI (partition key `userId`) — the same pattern
  `communications-repo.ts`'s `byAccountStatus` GSI already establishes — and switch to
  `QueryCommand`, which is required once the table holds more than one tenant's accounts (a Scan's
  cost and latency grow with total table size, not with one user's row count).

## 3. RAG cross-channel linking (`findRelated`) is single-hop

`packages/rag/src/linking.ts#findRelated` runs one `filterSearch` call over a shared metadata
dimension (`sourceId`/`participant`/`topic`/`project`/`asanaGid`) and returns that result set
directly — it does not recursively expand into "things related to the things it just found."

- **Why acceptable here:** every demo scenario's cross-channel connections are one hop deep (a
  gmail thread and an sms both tagged with the same `project`, an Asana task linked to the
  communication that spawned it) — exactly what `findRelated` proves.
- **Production fix:** for a genuinely deep thread (A relates to B relates to C, but A and C share
  no direct metadata dimension), add a bounded BFS/traversal over `findRelated` — expand the
  frontier hop by hop up to a small max depth, deduping visited `sourceId`s — rather than a single
  flat query.

## 4. `EMBEDDING_DIMENSION` is a hardcoded constant, not runtime-asserted

`packages/rag/src/model-config.ts` hardcodes `EMBEDDING_DIMENSION = 1536` (Cohere Embed v4's known
output size) and `index-mapping.ts` uses it directly to define the OpenSearch kNN field — nothing
asserts at runtime that a real embedding call actually returned a vector of that length before
it's indexed.

- **Why acceptable here:** the embed model id is pinned (not user- or env-configurable) for the
  whole demo, so the constant and the model's actual output dimension can never drift apart in
  practice.
- **Production fix:** assert `vector.length === EMBEDDING_DIMENSION` at the embed call site (or the
  index-write call site) and fail loudly/reject the write on mismatch, so a future model swap with
  a different output dimension surfaces as an immediate, clear error instead of a silent
  index-mapping mismatch or a confusing OpenSearch rejection deep in the pipeline.

## 5. `sanitizeAgentCoreKey` can collide two different identities

`apps/agent-handler/src/memory/conversation-event-store.ts#sanitizeAgentCoreKey` maps an arbitrary
email/thread-key identity into AgentCore's constrained key charset by replacing every disallowed
character with `_`; two different raw identities that differ only in the characters that get
replaced (e.g. two thread keys differing only by punctuation) can collide onto the same sanitized
key.

- **Why acceptable here:** this key only scopes AI conversation-turn history (memory), not an
  authorization boundary — a collision could bleed one thread's conversational context into
  another's model prompt, which is a quality/coherence issue, never a cross-account data-exposure
  issue (the account-scoped RAG retrieval permission boundary, design.md §10, is enforced entirely
  separately and is unaffected by this).
- **Production fix:** hash the raw identity (e.g. a short SHA-256 prefix) into the sanitized key
  instead of naive character replacement, so collisions become cryptographically negligible instead
  of merely unlikely for the current demo identity set.

## 6. `agent-trigger.ts` is duplicated per app

`apps/api/src/agent-trigger.ts` and `apps/ingest/src/agent-trigger.ts` are two independent,
near-identical modules that both publish `{ commId, accountId }` to the same SQS queue by
deterministic name.

- **Why acceptable here:** this mirrors the codebase's established "one small repo/trigger module
  per app, no shared runtime package for a five-line SQS publish" convention
  (`communications-repo.ts` is duplicated the same way across `apps/api`/`apps/ingest`/
  `apps/agent-handler` on purpose — see `apps/api/src/repos/communications-repo.ts`'s doc comment),
  and the two copies are small enough that drift is easy to spot in review.
- **Production fix:** if a third or fourth app ever needs the same publish, extract it into a
  shared internal package (`packages/agent-trigger` or similar) rather than a fourth copy —
  worthwhile once duplication factor grows past two, not before.

## 7. MCP token revocation is not built

`apps/api`'s MCP auth service can issue and verify per-user MCP tokens (Settings → MCP Tokens), but
there is no `revoke` procedure or revocation-list check on the verify path.

- **Why acceptable here:** every demo token is short-lived (minted for the assignment window) and
  scoped to one user's own data via the same account-ownership guard every other procedure routes
  through — a leaked token's blast radius is bounded to that one user's own communications, not a
  cross-tenant exposure.
- **Production fix:** add a `revoke(tokenId)` procedure that flips a `revokedAt` attribute on the
  token record, and have the verify path check it (or move to short-lived signed tokens with a
  separate refresh flow) — the issue+verify halves already exist, this is the missing third leg.

## 8. `chunkAsanaTask`'s `ts` metadata is sync-time, not the task's `modified_at`

`scripts/sync-asana.ts` stamps every synced Asana task chunk's `ts` with `new Date().toISOString()`
(the moment the sync script ran) rather than the task's actual Asana `modified_at` timestamp.

- **Why acceptable here:** the sync script is run fresh right before each demo, so sync-time and
  actual-modification-time are close enough that no retrieval-relevance or recency-sorting decision
  in the demo is affected.
- **Production fix:** thread `modified_at` through from the Asana API response into
  `AsanaTaskChunkInput.ts`, so a scheduled/periodic sync (rather than a manual pre-demo run)
  correctly reflects when a task actually last changed, not when it was last polled.

## 9. Attachment `sizeBytes` is a placeholder for some channels

`packages/connectors/src/whatsapp/normalize.ts` hardcodes `sizeBytes: 0` for WhatsApp attachments
("unknown until fetched — Twilio's webhook payload carries no size field"); Gmail's normalizer
reads a real size from the API response.

- **Why acceptable here:** `sizeBytes` is informational metadata only — nothing in the pipeline
  (dedup, attachment-size gating, storage) makes a correctness decision based on the WhatsApp value
  being accurate; the real byte count is knowable only after the attachment is actually fetched
  from Twilio's media URL, which happens downstream of normalization.
- **Production fix:** populate the real size once `persistAttachments` fetches the attachment bytes
  (`apps/ingest/src/processor-logic.ts`), patching the placeholder with the actual fetched length
  before it's persisted, rather than leaving `0` in the durable record.

## 10. Login/token is a demo credential model, not a full IdP

`apps/api/src/services/dashboard-login-service.ts` authenticates against a small, operator-
provisioned list of `{ username, passwordHash, userId }` entries in Secrets Manager — there is no
signup flow, password reset, MFA, or session/refresh-token rotation.

- **Why acceptable here:** this is a single-demo-user system (the brief's scope is one connected
  identity's cross-channel inbox); a full IdP would be pure overhead with nothing to actually
  exercise.
- **Production fix:** swap this service for Amazon Cognito (or another managed IdP) once there is a
  real multi-user signup/onboarding flow to support — the login procedure's surface (`login(
  username, password) -> token`) is already the right shape to sit in front of a managed IdP later.

## 11. `StyleProfileBuildDuration` is emitted but not graphed

`apps/agent-handler/src/style/build-style-profile.ts` publishes a `StyleProfileBuildDuration`
metric (documented in `cloudwatch-metrics.json`) on every `just build-style-profile` run, but
`lib/constructs/metrics-dashboard.ts` only wires `StyleProfileBuilt`/`StyleExemplarAdded` onto the
CloudWatch dashboard — the duration metric is queryable in CloudWatch but has no dashboard widget.

- **Why acceptable here:** `build-style-profile` is an infrequent, operator-triggered script (not a
  request-path operation), so its latency isn't a live operational signal the way request-duration
  metrics are; count-based metrics (built/exemplars-added) are what the dashboard's Task 10 section
  is meant to prove.
- **Production fix:** add a duration widget alongside the existing Task 10 widgets in
  `metrics-dashboard.ts` — the metric already exists and is registered, this is a dashboard
  layout change only.

## 12. `dashboard-credentials.ts`'s catch-all fails closed, masking real Secrets Manager misconfiguration

`apps/api/src/dashboard-credentials.ts#loadDashboardCredentials` wraps its Secrets Manager fetch in
a bare `catch` that returns `[]` for ANY error — an unprovisioned secret (expected, documented) and
a genuine misconfiguration (wrong IAM permissions, throttling, malformed JSON in the secret) both
degrade identically to "no one can log in," with no alarm distinguishing the two.

- **Why acceptable here:** failing closed (never granting access on an error) is the correct
  security posture regardless of which case triggered it, and for a single-operator demo deploy a
  broken login is immediately obvious by trying to log in — there's no silent-failure risk to an
  end user who doesn't know to check.
- **Production fix:** narrow the catch to the specific expected `ResourceNotFoundException` (secret
  genuinely not provisioned yet) and let every other error type propagate/alarm — e.g. emit a
  CloudWatch metric or log at `error` severity distinctly from the "secret not provisioned" case,
  so an IAM regression or a malformed secret value pages an operator instead of silently locking
  every user out.

## 13. WhatsApp runs on the Twilio sandbox, not a production sender

The WhatsApp channel (Task 9) is demonstrated against Twilio's WhatsApp sandbox, not a
Meta-business-verified production WhatsApp sender.

- **Why acceptable here:** documented in full in `docs/decisions/channel-access-tiers.md` §3/§7 —
  Meta business verification does not reliably fit the assignment window, and the sandbox exercises
  the identical bidirectional protocol (inbound webhook + outbound REST send) through the same
  `Connector` interface every other channel implements.
- **Production fix:** complete Meta business verification and swap the sandbox number for a
  production WhatsApp sender — a credential/endpoint change per the decision record, not a
  connector rewrite.

## 14. SMS is deferred (US A2P 10DLC registration)

SMS via Twilio, originally the planned second live channel, was not implemented in this delivery.

- **Why acceptable here:** documented in full in `docs/decisions/channel-access-tiers.md` §7 — US
  A2P 10DLC campaign registration/brand vetting is a multi-day-to-multi-week carrier approval
  process with no sandbox-equivalent bypass, unlike WhatsApp's immediately-usable Twilio sandbox.
  WhatsApp sandbox became the actual second-channel proof of the connector architecture instead.
- **Production fix:** complete A2P 10DLC registration for a Twilio SMS number, then implement the
  SMS connector against the same `Connector` interface (`ingest`/`send`/`identity`) — Twilio's REST
  API shape is what WhatsApp already exercises, so this is largely a credential/endpoint swap plus
  SMS-specific normalization, not new architecture.

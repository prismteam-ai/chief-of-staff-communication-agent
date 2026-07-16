# Chief of Staff Communication Agent — Implementation Plan

**Goal:** Ship the Chief of Staff Communication Agent — multi-channel ingestion into one knowledge
layer, RAG-backed recommendations and style-matched drafts, approval-before-send with Asana
follow-ups, a hosted dashboard, and a Cursor-accessible agent — per `docs/design.md`.

**Approach:** Build the spine first and keep it deployed from day one: Gmail live → knowledge layer →
recommend/draft → approval/send → Asana → dashboard, then close the multi-channel proof with SMS,
then style learning + Cursor, then channel breadth, then closure. Every task ends in a deployable,
demonstrable state; scope cuts only ever come from the breadth tail.

**Tech stack:** AWS us-east-2 (Lambda, API Gateway, SQS, DynamoDB, S3, OpenSearch, Bedrock, Secrets
Manager, EventBridge, CloudWatch), Amplify hosting, Turborepo + pnpm + TypeScript, tRPC, Vercel AI
SDK, AgentCore Memory, LangSmith, CDK.

## Global constraints

- **All acceptance criteria are in scope**, sequenced so the intent-bearing loop is proven earliest.
- **Region us-east-2** everywhere; `AWS_REGION` set explicitly in every runtime; Bedrock chat and
  embedding model ids pinned in one config module.
- **Two live channels (Gmail + SMS) before any breadth work** — multi-channel ingestion (README L43)
  is a demo criterion, not a stretch goal.
- **Demo data realism is continuous:** synthetic-but-realistic traffic flows through the real
  channels to dedicated demo accounts from the first channel deploy (Task 3); volume is topped up,
  never backfilled at the end. Historical backfill is deliberately replaced by continuous seeding —
  the corpus is born fresh, so no batch-import stage is needed.
- **Channel access tiers** (live / sandbox / constrained) per
  `docs/decisions/channel-access-tiers.md`; agent ingress per `docs/decisions/email-ingress.md`.
- **Submission:** fork-and-PR — push to `origin` (the fork), open the PR against the assignment
  repo at the end. A **draft PR** is opened earlier (Task 11) so the self-assessment can run with
  all four of its gates satisfiable.
- **Docs are EN-only.**

## Execution model

- **Agent-driven build:** every task names the kit agent and skill that drive it (`Drives:`), per the
  routing an `arceus` consultation returns for this assignment. `apply-engineering-guidelines` is the
  standing baseline on every task and is not repeated per task. Where the kit has no capability for
  a task's core work, the task says **no clean kit match** plainly and names what was consulted for
  pattern-only reuse — overclaiming a skill is worse than declaring the gap.
- **Milestone A — demoable triage loop = end of Task 6** (inbound → recommend → draft → approve →
  send → answered, on live Gmail). Everything after widens or hardens it.
- **Critical path:** T0 → T1 → T2 → T3 → T5 → T6. **Parallel tracks once the spine stands:**
  T7 ∥ T8 after T6; T10 ∥ T11 after T9; T12's four connectors are four independent workstreams
  (fan-out). RAG (T4) runs alongside T3 once the ingest contract exists; the agent consumes it at T5.
- **Speed:** elapsed time is measured to the latest commit — work lands in complete, verified task
  commits; no post-submission dribbling.
- **Milestone demo clips** are recorded at T6, T9, and T11 as insurance for the final demo video.

## File structure (this repo)

```
docs/
  design.md                        # architecture (committed)
  plan.md                          # this plan
  decisions/channel-access-tiers.md
  decisions/email-ingress.md
  setup.md                         # non-technical setup + reviewer guide (Task 13)
  demo-storyboard.md               # demo script + clip inventory (Task 14)
apps/
  web/                             # dashboard (Amplify)
  api/                             # tRPC on Lambda
  agent-handler/                   # agent brain Lambda (pidgeot)
  ingest/                          # channel webhook Lambdas + poller + SQS processor
packages/
  shared/                          # domain logic, contracts, state machine (one source of truth)
  connectors/                      # channel connector interface + per-channel implementations
  api-client/  tsconfig/
mcp/                               # MCP server (npx-runnable, calls the hosted API)
kit/                               # ecosystem packaging staged for a kit PR (agents/pidgeot.md, skills/use-pidgeot/, mcp.json entry)
bin/ lib/ cdk.json                 # one CDK app; stacks: Ingest, Rag, Agent, Api, Amplify
fixtures/
  rag/                             # corpus + golden queries for local replay
  e2e/                             # inbound-message fixtures → expected recommendation class
infra/run-records/                 # deploy/verification records
justfile  .github/workflows/       # CI: format → lint → type-check → test → build → deploy
```

---

## Task 0: Bootstrap — accounts, model access, workspace

**Drives:** no clean kit match (operator bootstrap); engineering baseline per
`apply-engineering-guidelines`.

- [ ] AWS account ready in us-east-2; `cdk bootstrap`.
- [ ] Submit the Anthropic-on-Bedrock use-case form; verify chat model and embedding model
      availability (`list-foundation-models`); pin the chosen model ids (chat + embed) in config.
- [ ] Provision demo accounts: Gmail demo mailboxes for two demo users (plus one named non-Gmail
      IMAP account, e.g. Outlook, for Task 12), Twilio (verify trial limits — upgrade or document),
      Asana workspace + PAT, LangSmith project, PagerDuty account + Events API v2 routing key.
- [ ] Secrets Manager entries for every credential; nothing in env files.

**Verify:** one Bedrock chat call and one embedding call succeed in us-east-2; `select 1`-level
checks for each provider API.
**Commit:** `infra/run-records/bootstrap.md` (steps + verifications, no secrets).

## Task 1: Monorepo skeleton + CI + first deploy

**Drives:** `metagross` → `build-frontend-backends` + `integrate-ci-cd`.

- [ ] Turborepo/pnpm skeleton per the file structure; `packages/tsconfig`, Prettier/ESLint, Vitest.
- [ ] One root CDK app with empty-but-deployable stacks (Ingest, Rag, Agent, Api, Amplify);
      Powertools wiring and the metrics registry (`cloudwatch-metrics.json`) + CDK CloudWatch
      dashboard from the start.
- [ ] Discover the CDK bootstrap qualifier per `integrate-ci-cd` step 2 and pass it to every
      synth/deploy; do not guess.
- [ ] `justfile` (six recipes) + `.github/workflows/ci-cd-dev.yml` (PRs) and `ci-cd-prod.yml`
      (push to the feature branch → deploy — documented adaptation: the kit's prod trigger is push
      to `main`, but this fork's `main` mirrors the upstream assignment repo, so the feature branch
      is the deployable line), OIDC to the AWS account.
- [ ] Post-deploy smoke test in CI: the Amplify URL and the API health route respond after deploy.
- [ ] Amplify app connected to this fork (`apps/web` monorepo appRoot) serving a hello dashboard;
      API Gateway custom URL serving a hello tRPC route.

**Verify:** CI green including the smoke test; `cdk deploy` from CI; both URLs respond publicly.
**Commit:** skeleton + `infra/run-records/first-deploy.md` (URLs).

## Task 2: Contracts, state machine, account model

**Drives:** `metagross` → `build-frontend-backends` (shared packages); tool/request contracts
cross-checked against the `build-ai-agents` typed multi-intent contract pattern.

- [ ] `packages/shared`: `NormalizedMessage` (Zod; additive-field versioning policy documented in
      the type), the communication state machine (`ingested → … → answered | dismissed`, transitions
      as conditional writes), account model (`account_id` on every record), per-user permission
      checks as a shared guard.
- [ ] DynamoDB tables (CDK): communications/state, accounts, dedupe/idempotency store, style
      profiles; S3 raw-artifact bucket.
- [ ] `packages/connectors`: the connector interface (`ingest`, `send?`, `identity`).

**Verify:** Vitest covers every legal/illegal state transition and the permission guard
(user A cannot read user B).
**Commit:** shared contracts + tables.

## Task 3: Gmail connector live (first channel)

**Drives:** no clean kit match — inbound-channel ingestion (see `docs/decisions/email-ingress.md`);
`chatot` → `manage-communication-activity` consulted for **pattern only** (idempotent persistence
keyed on the provider message id, retry/DLQ for unprocessable events, documented provider-credential
source); `build-rag-systems` webhook-ingestion rules for the signature/raw-event/dedupe shape.

- [ ] Gmail OAuth (restricted scopes), tokens to Secrets Manager; two demo users, multiple accounts
      (multi-brand, README L13).
- [ ] Ingestion: incremental history poller on EventBridge Scheduler first (sanctioned fallback),
      Pub/Sub push upgrade after; webhook/poller → SQS (+DLQ + the full alarm per the DLQ rule) →
      processor → dedupe on provider message id (conditional write) → NormalizedMessage → persist.
- [ ] Thread keys from Gmail threading; participants, timestamps, attachments to S3 (README L21).
- [ ] `just seed-demo`: committed, runnable seeding recipe — realistic threads flowing into the demo
      mailboxes, plus a sent-history corpus per demo user (feeds Task 10 style learning). Seeding
      starts here and runs continuously.

**Verify:** a message sent to the demo mailbox appears as a persisted, deduped `NormalizedMessage`
with thread key and attachments; replay of the same event does not duplicate; `MessageIngested`
metric visible on the dashboard.
**Commit:** Gmail connector + ingest pipeline + `just seed-demo`.

## Task 4: Knowledge layer + RAG

**Drives:** `alakazam` → `build-rag-systems` (direct-build flow — local-first verification).

- [ ] **Local path first-class:** `fixtures/rag/` corpus + golden queries; Docker OpenSearch +
      SAM-local replay passing before any AWS adapter work (the OpenSearch domain — single-node
      `t3.small.search`, documented — may be provisioned in parallel; verification stays
      local-first per the skill).
- [ ] Index mapping for chunks (deterministic ids, `text_for_embedding`/`text_for_context`,
      metadata: channel, account, participants, topic, project, asana ids, timestamps).
- [ ] Embedding pipeline in the ingest processor (Bedrock, pinned model from Task 0);
      communications, seeded org documents, and seeded user preferences indexed. Asana context
      chunks land in Task 7 when the Asana client exists — T4 exercises the corpus shape with
      seeded fixtures.
- [ ] Cross-channel link records + metadata filters (README L28); "workstreams" map to Asana
      projects/topics in the linking metadata.
- [ ] Golden queries replayed against the deployed index after adapters land; retrieval assertions
      are deterministic (fixed corpus → expected ids) as distinct from generative outputs.

**Verify:** golden queries return the expected records with citations, locally and deployed;
retrieval latency acceptable for the <5-minute loop.
**Commit:** RAG stack + fixtures + replay records.

## Task 5: Agent brain (pidgeot)

**Drives:** `ash` → `build-ai-agents` (kit interior kept intact; ingress per
`docs/decisions/email-ingress.md`).

- [ ] `apps/agent-handler`: Bedrock via Vercel AI SDK `ToolLoopAgent` + prompt caching (pinned model
      id); tools `retrieveContext`, `recommendAction`, `draftReply`, `manageAsana` (from
      `packages/shared`; `manageAsana` is a typed contract stub until Task 7); AgentCore Memory
      behind `ConversationEventStore` (session = thread key, actor = sender, idempotent event
      tokens); LangSmith tracing.
- [ ] Triggered from the ingest pipeline per new communication: recommend + draft (generic style v0)
      + confidence score; below threshold → `needs_context` (README L32).
- [ ] `fixtures/e2e/`: inbound-message fixtures → expected recommendation **class** (action type,
      not exact wording) — the end-to-end replay that complements the RAG golden queries.

**Verify:** a live inbound email produces a recommendation + draft with retrieved context attached,
visible in LangSmith; low-confidence fixture lands in `needs_context`; e2e fixtures classify as
expected.
**Commit:** agent runtime + e2e fixtures.

## Task 6: Approval loop + send  — **Milestone A closes here**

**Drives:** `chatot` → `manage-communication-activity` (send handoff, send idempotency, provider
send-confirmation ingestion, `sent → answered` activity closure — not fire-and-forget); co-driver
`metagross` → `build-frontend-backends` (tRPC approval procedures + minimal approval UI + audit
trail).

- [ ] tRPC procedures + **minimal approval UI** (a working approve/edit/reject/dismiss/
      supply-context surface — full dashboard views arrive in Task 8): server-side transitions with
      conditional writes; audit trail with timestamps at every transition (feeds response-time
      metrics).
- [ ] Send via the owning connector: Gmail API send with `In-Reply-To`/`References`; provider send
      confirmation moves `sent → answered`.
- [ ] Record milestone demo clip (triage loop end-to-end).

**Verify:** full loop live: inbound → recommended → drafted → approved → sent → answered; the reply
lands correctly threaded in the counterpart mailbox; dismissed items stop the overdue clock.
**Commit:** approval + send path + clip in the demo inventory.

## Task 7: Asana integration (∥ Task 8)

**Drives:** no clean single builder — `ash` → `build-ai-agents` Asana rules (PAT and per-environment
discipline), with `hypno`'s confirm-gated write-guardrail pattern cited for approval-gated writes.

- [ ] Asana client: link communications to tasks/projects/milestones/comments; create/update
      follow-up tasks (README L29-L30); **extends the Task 4 corpus with live Asana context**
      (tasks/projects/milestones/comments indexed).
- [ ] Writes approval-gated; task notes carry communication context + provenance.

**Verify:** approving a follow-up recommendation creates/updates the Asana task in the demo
workspace; the link is visible from both sides; a retrieval query returns communication AND Asana
evidence together (README L44 now demonstrable).
**Commit:** Asana integration.

## Task 8: Dashboard views (∥ Task 7)

**Drives:** `metagross` → `build-frontend-backends`; `smeargle` → `responsive-design-tests`
(adapted: no Figma source — breakpoint-config Playwright pattern applied to `apps/web`, adaptation
documented).

- [ ] `apps/web`: metrics view (volume, response status, overdue, pending approvals, channel
      breakdown, response-time — README L35), recommended-actions view (L36),
      drafts-awaiting-approval view (L37); auth with two demo users proving the permission
      boundary (L42).
- [ ] Per-user **MCP token issuance** view (scoped API tokens for Task 11) and a user preferences
      setting (source of the "stored explicit preferences" RAG input).
- [ ] Playwright design tests: mobile/tablet/desktop breakpoint configs + one deployed-URL spec.

**Verify:** all three views live on the Amplify URL against real flowing data; user A cannot see
user B's accounts; overdue flag flips at the 5-minute mark; design tests green.
**Commit:** dashboard + design tests.

## Task 9: SMS connector + multi-channel closure

**Drives:** `chatot` → `manage-communication-activity` + `rules/quiq-delivery-and-feedback.md` with
the provider letter adapted Quiq→Twilio (endpoint/payload/auth swapped; credential ARN, routing,
correlation store, normalized status outcomes, idempotency key, retry/DLQ kept as prescribed) —
governs outbound send, delivery feedback, and correlation of replies to our own sends; unsolicited
inbound webhook ingestion follows the ingress decision record (no clean kit match, same connector
pipeline).

- [ ] Twilio SMS connector: inbound webhook → same pipeline; send via Twilio; account per Task 0.
- [ ] Cross-channel linking demonstrated: an email thread and an SMS from the same person/topic
      linked and retrievable together (README L24, L28 closed; L43 satisfiable).
- [ ] Record milestone demo clip (SMS + email side by side).

**Verify:** a live SMS appears on the dashboard next to email, linked by person/topic; a reply to
our sent SMS correlates back to the originating communication (the skill's response-ingestion case);
ingestion demo criterion (L43) reproducible on demand.
**Commit:** SMS connector + linking evidence + clip.

## Task 10: Style learning (∥ Task 11)

**Drives:** `alakazam` → `build-rag-systems` (prior-decision-reuse pattern: approved/edited drafts
persisted as future retrieval evidence — the skill's review-loop applied to style).

- [ ] Style profile per user from the seeded sent-history: embedded exemplars + extracted style
      card; injected into `draftReply`; approved/edited drafts appended to the profile.

**Verify:** side-by-side draft for the same inbound with two different demo users shows clearly
different, user-consistent voice; edits demonstrably shift subsequent drafts (README L25, L46).
**Commit:** style learner.

## Task 11: Cursor agent + ecosystem packaging (∥ Task 10)

**Drives:** `ash` → `build-ai-agents` (new-agent creation flow + `foundation-agent-naming`); the
kit's `use-<agent>` skill shape and donphan `mcp.json` wiring as packaging precedent.

- [ ] `mcp/`: MCP server (stdio, npx-runnable via a resolvable `--package=github:...` source)
      exposing the four shared tools **plus the approval surface: `approveDraft` and
      `supplyContext`** (README L9's stated purpose of the Cursor workflow), calling the hosted API
      with a per-user scoped token issued in the dashboard (Task 8); Asana writes and `approveDraft`
      confirm-gated (hypno pattern).
- [ ] `kit/`: `agents/pidgeot.md` + `skills/use-pidgeot/SKILL.md` + `mcp.json` entry — **staged as a
      PR-ready patch to the kit repo**, following the kit's full new-agent checklist: frontmatter
      per `validate-plugin.sh` (kebab-case name matching filename, description, non-empty body),
      README roster row, `agents-copilot`/`.codex` sync outputs, manifest version bump, local
      install smoke test; naming record (collision-checked; "why pidgeot" line;
      `LANGSMITH_PROJECT=pidgeot-agent` and `pidgeot-agent` identifier prefixes).
- [ ] Verify in Cursor with a free account: MCP connects, retrieval/recommend/draft/approve/
      supply-context/Asana work end-to-end (README L38-L40); record milestone demo clip.
- [ ] **Open the draft PR** to the assignment repo (runtime URLs, credentials note, clip links) and
      run the **interim `slowking` self-assessment** against it — all four gates (PR, runtime,
      credentials, demo artifact) satisfiable; fix findings before breadth work.

**Verify:** MCP inspector run + the recorded Cursor session; interim slowking findings triaged.
**Commit:** MCP server + kit packaging + draft-PR + assessment record.

## Task 12: Channel breadth (fan-out: four independent connectors)

**Drives:** no clean kit match — all four are inbound/read-only acquisition outside the
communication-activity loop (ingress decision record applies); `chatot` consulted for per-connector
channel-config discipline (documented credential source, explicit routing rules); WhatsApp sandbox
send, if exercised, extends Task 9's adapted Twilio rule.

- [ ] Second email provider: IMAP connector, generic for any IMAP provider; demoed on the named
      Outlook account (README L15 "providers", plural, honestly met).
- [ ] WhatsApp: Twilio sandbox connector (live sandbox session).
- [ ] X: xAI Live Search connector (read-only, public posts/mentions; data acquisition only).
- [ ] LinkedIn: notification-derived connector (read-only) — **live** via real LinkedIn
      notification emails flowing to the demo mailbox through the Gmail connector, plus recorded
      fixtures for connector tests.
- [ ] Each channel visible in the dashboard channel breakdown with live/sandbox/fixture provenance
      labeled honestly.

**Verify:** each connector ingests through the same pipeline with zero downstream changes — the
modularity proof (README L20; channels L15, L17-L19).
**Commit:** four connectors.

## Task 13: Setup experience + ops closure

**Drives:** `metagross` → `build-frontend-backends` (wizard); `responsive-design-tests` (wizard
walkthrough coverage); ops per the engineering baseline.

- [ ] Connect-channel wizard in the dashboard (README L12); `docs/setup.md` for non-technical users
      + reviewer guide (L49).
- [ ] Ops drill: PagerDuty page proven on a forced critical failure (prod-gated); DLQ alarm fires
      with **ALARM and OK actions fanning out through the SNS channel topic** and self-resolves on
      drain (full rule: `ApproximateNumberOfMessagesVisible`/Maximum, threshold >0, 1/1 evaluation,
      `treatMissingData: NOT_BREACHING`; PagerDuty subscription production-only); metrics registry
      complete; data volume topped up to realistic scale across channels.

**Verify:** a non-technical walkthrough of the wizard succeeds; forced-failure drill recorded with
the fan-out observed.
**Commit:** wizard + setup docs + drill record.

## Task 14: Self-assessment, demo, PR

**Drives:** `slowking` → `evaluate-candidate-intent` / `-product` / `-implementation`;
`babysit-release` for the assignment PR (**PR-readiness half only** — CI green, comments triaged,
mergeable; merge and release belong to the client — documented boundary).

- [ ] Final `slowking` run against the (draft) PR + live runtime + demo + credentials; fix findings.
- [ ] `docs/demo-storyboard.md`: script mapped to L43-L48 + clip inventory (T6/T9/T11 clips as
      fallback material); record the final demo video; state hosting/format in the PR.
- [ ] Mark the PR ready for review: runtime URLs, working credentials, demo video, setup docs,
      decision records; babysit PR readiness.
- [ ] Clean-browser (incognito) check: runtime reachable and usable with ONLY what the PR provides.

**Verify:** the hosted runtime passes the clean-browser check; the demo shows every "Demonstrate"
criterion; slowking findings addressed.
**Commit / PR:** final PR.

---

## Self-review (design coverage)

- Multi-channel ingestion + modular connectors → Tasks 3, 9, 12 (L13-L22, L43).
- Central knowledge layer + RAG over all four sources → Tasks 4, 7 (L22-L24, L44).
- Cross-channel linking → Tasks 4, 9 (L28).
- Recommended action per communication → Task 5; surfaced in the Task 8 view (L26, L36, L45).
- Learned style-matched drafts → Tasks 5, 10 (L25, L27, L46).
- Approval before send + needs-context → Tasks 5, 6, 8 (L31-L32, L47).
- Asana linking + task create/update → Task 7 (L29-L30, L48).
- Answered-tracking + <5-min visibility → Tasks 6, 8 (L33-L37).
- Cursor agent incl. approval + context supply → Task 11 (L38-L40, L9).
- Tokens + permission boundaries → Tasks 0, 2, 8 (L41-L42).
- Setup simplicity + docs → Task 13 (L12, L49).
- Ecosystem reusability → Task 11 (L50).
- Deployed runtime + credentials + demo → Tasks 1 (from day one), 11 (draft PR + interim
  self-assessment), 14.

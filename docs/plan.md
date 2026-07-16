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
- **Region us-east-2** everywhere; `AWS_REGION` set explicitly in every runtime.
- **Two live channels (Gmail + SMS) before any breadth work** — multi-channel ingestion (README L43)
  is a demo criterion, not a stretch goal.
- **Demo data realism is continuous:** synthetic-but-realistic traffic flows through the real
  channels to dedicated demo accounts from the first deploy; volume is topped up, never backfilled
  at the end.
- **Channel access tiers** (live / sandbox / constrained) per
  `docs/decisions/channel-access-tiers.md`; agent ingress per `docs/decisions/email-ingress.md`.
- **Submission:** fork-and-PR — push to `origin` (the fork), open the PR against the assignment
  repo at the end.
- **Docs are EN-only.**

## File structure (this repo)

```
docs/
  design.md                        # architecture (committed)
  plan.md                          # this plan
  decisions/channel-access-tiers.md
  decisions/email-ingress.md
  setup.md                         # non-technical setup + reviewer guide (Task 13)
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
kit/                               # ecosystem packaging: agents/pidgeot.md, skills/use-pidgeot/, mcp.json entry
bin/ lib/ cdk.json                 # one CDK app; stacks: Ingest, Rag, Agent, Api, Amplify
fixtures/rag/                      # corpus + golden queries for local replay
infra/run-records/                 # deploy/verification records
justfile  .github/workflows/       # CI: format → lint → type-check → test → build → deploy
```

---

## Task 0: Bootstrap — accounts, model access, workspace

- [ ] AWS account ready in us-east-2; `cdk bootstrap`.
- [ ] Submit the Anthropic-on-Bedrock use-case form; verify chat model and embedding model
      availability (`list-foundation-models`); pick Cohere Embed v4 or Titan v2 accordingly.
- [ ] Provision demo accounts: Gmail demo mailbox(es) for two demo users, Twilio (verify trial
      limits — upgrade or document), Asana workspace + PAT, LangSmith project, PagerDuty account +
      Events API v2 routing key.
- [ ] Secrets Manager entries for every credential; nothing in env files.

**Verify:** one Bedrock chat call and one embedding call succeed in us-east-2; `select 1`-level
checks for each provider API.
**Commit:** `infra/run-records/bootstrap.md` (steps + verifications, no secrets).

## Task 1: Monorepo skeleton + CI + first deploy

- [ ] Turborepo/pnpm skeleton per the file structure; `packages/tsconfig`, Prettier/ESLint, Vitest.
- [ ] One root CDK app with empty-but-deployable stacks (Ingest, Rag, Agent, Api, Amplify);
      Powertools wiring and the metrics registry (`cloudwatch-metrics.json`) + CDK CloudWatch
      dashboard from the start.
- [ ] `justfile` (six recipes) + `.github/workflows/ci-cd-dev.yml` (PRs) and `ci-cd-prod.yml`
      (push to the feature branch → deploy), OIDC to the AWS account.
- [ ] Amplify app connected to this fork (`apps/web` monorepo appRoot) serving a hello dashboard;
      API Gateway custom URL serving a hello tRPC route.

**Verify:** CI green; `cdk deploy` from CI; the Amplify URL and the API URL respond publicly.
**Commit:** skeleton + `infra/run-records/first-deploy.md` (URLs).

## Task 2: Contracts, state machine, account model

- [ ] `packages/shared`: `NormalizedMessage` (Zod), the communication state machine
      (`ingested → … → answered | dismissed`, transitions as conditional writes), account model
      (`account_id` on every record), per-user permission checks as a shared guard.
- [ ] DynamoDB tables (CDK): communications/state, accounts, dedupe/idempotency store, style
      profiles; S3 raw-artifact bucket.
- [ ] `packages/connectors`: the connector interface (`ingest`, `send?`, `identity`).

**Verify:** Vitest covers every legal/illegal state transition and the permission guard
(user A cannot read user B).
**Commit:** shared contracts + tables.

## Task 3: Gmail connector live (first channel)

- [ ] Gmail OAuth (restricted scopes), tokens to Secrets Manager; two demo users, multiple accounts
      (multi-brand, README L13).
- [ ] Ingestion: incremental history poller on EventBridge Scheduler first (sanctioned fallback),
      Pub/Sub push upgrade after; webhook/poller → SQS (+DLQ + self-resolving alarm) → processor →
      dedupe on provider message id (conditional write) → NormalizedMessage → persist.
- [ ] Thread keys from Gmail threading; participants, timestamps, attachments to S3 (README L21).
- [ ] Continuous demo-traffic seeding starts: realistic threads flowing into the demo mailboxes,
      plus a sent-history corpus per demo user (feeds Task 10 style learning).

**Verify:** a message sent to the demo mailbox appears as a persisted, deduped `NormalizedMessage`
with thread key and attachments; replay of the same event does not duplicate; `MessageIngested`
metric visible on the dashboard.
**Commit:** Gmail connector + ingest pipeline.

## Task 4: Knowledge layer + RAG

- [ ] OpenSearch domain (single-node `t3.small.search`, documented); index mapping for chunks
      (deterministic ids, `text_for_embedding`/`text_for_context`, metadata: channel, account,
      participants, topic, project, asana ids, timestamps).
- [ ] Embedding pipeline in the ingest processor (Bedrock, model per Task 0); Asana context,
      user preferences, and seeded org documents indexed alongside communications (README L23).
- [ ] `fixtures/rag/` corpus + golden queries; Docker OpenSearch + SAM-local replay locally, the
      same golden queries replayed against the deployed index.
- [ ] Cross-channel link records + metadata filters (README L28).

**Verify:** golden queries return the expected records with citations, locally and deployed;
retrieval latency acceptable for the <5-minute loop.
**Commit:** RAG stack + fixtures + replay records.

## Task 5: Agent brain (pidgeot)

- [ ] `apps/agent-handler`: Bedrock via Vercel AI SDK `ToolLoopAgent` + prompt caching; tools
      `retrieveContext`, `recommendAction`, `draftReply`, `manageAsana` (from `packages/shared`);
      AgentCore Memory behind `ConversationEventStore` (session = thread key, actor = sender,
      idempotent event tokens); LangSmith tracing.
- [ ] Triggered from the ingest pipeline per new communication: recommend + draft (generic style v0)
      + confidence score; below threshold → `needs_context` (README L32).

**Verify:** a live inbound email produces a recommendation + draft with retrieved context attached,
visible in LangSmith; low-confidence fixture lands in `needs_context`.
**Commit:** agent runtime.

## Task 6: Approval loop + send

- [ ] tRPC procedures + dashboard actions: approve / edit / reject / dismiss / supply-context;
      server-side transitions with conditional writes; audit trail with timestamps at every
      transition (feeds response-time metrics).
- [ ] Send via the owning connector: Gmail API send with `In-Reply-To`/`References`; provider send
      confirmation moves `sent → answered`.

**Verify:** full loop live: inbound → recommended → drafted → approved → sent → answered; the reply
lands correctly threaded in the counterpart mailbox; dismissed items stop the overdue clock.
**Commit:** approval + send path.

## Task 7: Asana integration

- [ ] Asana client: link communications to tasks/projects/milestones/comments; create/update
      follow-up tasks (README L29-L30); Asana context indexed into the corpus (Task 4 dependency).
- [ ] Writes approval-gated; task notes carry communication context + provenance.

**Verify:** approving a follow-up recommendation creates/updates the Asana task in the demo
workspace; the link is visible from both sides.
**Commit:** Asana integration.

## Task 8: Dashboard views

- [ ] `apps/web`: metrics view (volume, response status, overdue, pending approvals, channel
      breakdown, response-time — README L35), recommended-actions view (L36),
      drafts-awaiting-approval view (L37); auth with two demo users proving the permission
      boundary (L42).

**Verify:** all three views live on the Amplify URL against real flowing data; user A cannot see
user B's accounts; overdue flag flips at the 5-minute mark.
**Commit:** dashboard.

## Task 9: SMS connector + multi-channel closure

- [ ] Twilio SMS connector: inbound webhook → same pipeline; send via Twilio; account provisioned
      per Task 0 findings.
- [ ] Cross-channel linking demonstrated: an email thread and an SMS from the same person/topic
      linked and retrievable together (README L24, L28 closed; L43 satisfiable).

**Verify:** a live SMS appears on the dashboard next to email, linked by person/topic; ingestion
demo criterion (L43) reproducible on demand.
**Commit:** SMS connector + linking evidence.

## Task 10: Style learning

- [ ] Style profile per user from the seeded sent-history: embedded exemplars + extracted style
      card; injected into `draftReply`; approved/edited drafts appended to the profile.

**Verify:** side-by-side draft for the same inbound with two different demo users shows clearly
different, user-consistent voice; edits demonstrably shift subsequent drafts (README L25, L46).
**Commit:** style learner.

## Task 11: Cursor agent + ecosystem packaging

- [ ] `mcp/`: MCP server (stdio, npx-runnable) exposing the four shared tools, calling the hosted
      API with a per-user scoped token issued in the dashboard; Asana writes confirm-gated.
- [ ] `kit/`: `agents/pidgeot.md` + `skills/use-pidgeot/SKILL.md` + `mcp.json` entry, following the
      kit's packaging conventions (README L50).
- [ ] Verify in Cursor with a free account: MCP connects, retrieval/recommend/draft/Asana work
      end-to-end (README L38-L40).

**Verify:** MCP inspector run + a recorded Cursor session performing all four capabilities.
**Commit:** MCP server + kit packaging.

## Task 12: Channel breadth

- [ ] Second email provider: IMAP/Outlook connector (live).
- [ ] WhatsApp: Twilio sandbox connector (live sandbox session).
- [ ] X: xAI Live Search connector (read-only, public posts/mentions; data acquisition only).
- [ ] LinkedIn: notification-derived connector (read-only), exercised against recorded fixtures.
- [ ] Each channel visible in the dashboard channel breakdown with real/sandbox/fixture provenance
      labeled honestly.

**Verify:** each connector ingests through the same pipeline with zero downstream changes — the
modularity proof (README L14-L20).
**Commit:** four connectors.

## Task 13: Setup experience + ops closure

- [ ] Connect-channel wizard in the dashboard (README L12); `docs/setup.md` for non-technical users
      + reviewer guide (L49).
- [ ] Ops: PagerDuty page proven on a forced critical failure (prod-gated), DLQ alarm fires and
      self-resolves on drain, metrics registry complete, data volume topped up to realistic scale
      across channels.

**Verify:** a non-technical walkthrough of the wizard succeeds; forced-failure drill recorded.
**Commit:** wizard + setup docs + drill record.

## Task 14: Self-assessment, demo, PR

- [ ] Self-assess with `slowking` against the assignment (per the client's guidance); fix findings.
- [ ] Demo video: the full triage loop on live multi-channel data (L43-L48 in one take).
- [ ] PR from `feat/pidgeot-agent` → the assignment repo: runtime URLs, working credentials, demo
      video, setup docs, decision records.

**Verify:** the hosted runtime is reachable and usable with the credentials from the PR alone; the
demo shows every "Demonstrate" criterion.
**Commit / PR:** final PR.

---

## Self-review (design coverage)

- Multi-channel ingestion + modular connectors → Tasks 3, 9, 12 (L13-L22, L43).
- Central knowledge layer + RAG over all four sources → Task 4 (L22-L24, L44).
- Recommended action per communication → Task 5 (L26, L36, L45).
- Learned style-matched drafts → Tasks 5, 10 (L25, L27, L46).
- Approval before send + needs-context → Tasks 5, 6, 8 (L31-L32, L47).
- Asana linking + task create/update → Task 7 (L28-L30, L48).
- Answered-tracking + <5-min visibility → Tasks 6, 8 (L33-L37).
- Cursor agent → Task 11 (L38-L40).
- Tokens + permission boundaries → Tasks 0, 2, 8 (L41-L42).
- Setup simplicity + docs → Task 13 (L12, L49).
- Ecosystem reusability → Task 11 (L50).
- Deployed runtime + credentials + demo → Tasks 1 (from day one), 14.

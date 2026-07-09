# chief-of-staff-communication-agent — Internal Context

## Rules
1. This is the only internal documentation file in this repo. AI context, decisions, ops patterns, and lessons all go here.
2. README.md is the acceptance contract (criteria + demo expectations). Never edit it to match the code — the code moves toward it, not the other way.
3. If this file disagrees with the code, **the code wins** — fix the doc.
4. Document a decision *after* it's made and proven, not before.
5. Never create conflicting concepts or logics in this document.
6. No PBI files, agent_reflections, delegation templates, multi-agent orchestration, ADRs, pre-implementation specs. Single-developer pace; agile + documentation-late. (Inherited from the oracle-pipeline sibling / polishy lineage.)

## Reality hierarchy
Code files are plans — what *should* exist. The message store, the connected accounts, the RAG index, and the Asana workspace are reality — what *does* exist. When they disagree, reality is right.
- Any claim about ingested messages cites raw output: a live store query, a connector sync log, an actual API response. Never summarize what the connector code should have fetched and present it as state.
- Never fabricate a message id, thread, account name, Asana task URL, or count that merely "looks right." Verify (a live query, an API call) or ask.
- (Origin: an ancestor validator shipped against a table that existed only as a SQLAlchemy model. "If it's not in the live schema, it doesn't exist.")

## Naming
- **channel** — one communication medium: gmail, other-email, sms, whatsapp, x, linkedin (extensible)
- **connector** — the per-channel integration module (modular connector architecture is an acceptance criterion)
- **account** — one authenticated identity on a channel; brands × channels give multiple accounts
- **message / thread** — normalized units in the store, with participants, timestamps, metadata, attachments where available
- **topic link** — a cross-channel association: messages that belong to the same person, customer, project, or decision
- **recommendation** — the suggested next action attached to an incoming message
- **draft** — a style-matched suggested reply, always awaiting approval
- **approval** — the human gate; nothing sends without it
- **knowledge layer** — the centralized store + RAG index over comms history, Asana context, user preferences, org knowledge
- **the agent** — a deliverable: the Cursor-accessible agent that retrieves context through the RAG layer, recommends actions, drafts replies, updates Asana. Everywhere the README says "agent", it means this shipped component — NOT Claude Code. Claude Code is the builder; the agent is built, tested, and demoed as product.

## Business context (flagship: the Notion page)
This project is a **Prism job-trial assignment** (AI Architect / Architectural Operator role) — the second of two. README.md is the "homework doc" (user story); the business context lives in Notion: [Prism Agent Dev Trial](https://app.notion.com/p/arthurcho/Prism-Agent-Dev-Trial-396b8d53366080f7b984d2c2bcaa32c1) — child page "Email comms" has the full brief, and this project's consolidated business context is maintained on the child page [chief-of-staff-communication-agent](https://app.notion.com/p/396b8d53366080a6bfb6ff640cfa6682) (keep it in sync when business facts change; engineering context stays here). Key facts:
- **Deliverable**: a pull request to `prismteam-ai/chief-of-staff-communication-agent` containing a short demo video + instructions/access to a **live/working runtime**.
- **Grader**: the `slowking` agent in soofi-xyz-team-kit (cloned at `../refs/soofi-xyz-team-kit`). Rubric (verified 2026-07-07, same as sibling): Functional outcome 40, Runtime & demo 20, Evidence 12, Access-boundary 8, Implementation 7, Kit-usage 5, Reproducibility 4, Speed 4. **Hard gates, automatic 0/100**: no publicly hosted runtime URL (localhost/tunnel-to-own-machine/local-setup = instant fail); missing PR; unreachable or login-blocked runtime — slowking gets ONE operator-assisted access attempt, so working demo credentials must ship with the PR. Self-assess with slowking before submitting.
- **Speed of delivery** is one of the biggest assessment factors (elapsed time measured from commit timestamps). Quality is the assumed baseline; mistakes are acceptable only when codified into skill/agent improvements so they don't repeat.
- Prism's working model: work **through** prebuilt skills/agent kits and improve them when they break — don't solve ad hoc; codify. Kit-usage is a scored dimension, and it's not vibes: slowking consults **`arceus`** (the kit's master router) as the answer key for which agents/skills *should* have built each part. Expected owners for this build (kit survey 2026-07-08): **chatot** (`manage-communication-activity` — provider adapters, send/delivery/response lifecycle), **oranguru** (`assemble-communication-runtime`), **xatu** (`select-communication-audience`), **wigglytuff** (`manage-channel-templates`) for comms; **ash** (`build-ai-agents` — Asana-triggered Lambda agent with human-in-the-loop approval task; closest pattern to this product) for the agent; **espeon/alakazam** (`build-local-rag-pocs`/`build-rag-systems`) for RAG; **metagross** (`build-frontend-backends`) for the dashboard; **donphan**'s MCP pattern for the Cursor surface. Name these mappings in the submission.
- **Kit golden path** (`apply-engineering-guidelines`, verified 2026-07-08) — deviations cost kit-usage/implementation points (~12/100 max exposure): TypeScript for all services (Python only for Glue/PySpark); **all LLM calls through the Vercel AI SDK** with Zod tool schemas — direct provider SDKs forbidden; AWS + CDK as the only IaC; Vitest, Prettier+ESLint, structured logging.
- First assignment (`oracle-property-intelligence-platform-pipeline-completion`) is the sibling repo — out of scope here, but its CLAUDE.md is this doc's ancestor.
- **Original job posting** (Notion child page "pervious job requirements (maybe outdated)" — dated context, treat as background not requirements): role is "Architectural Operator", not traditional engineering — design systems that produce software; "agentic layering" (agents that create/orchestrate/evolve other agents); decompose business functions into agentic workflows; contribute to the open-source soofi.xyz library. **Prism's embedded stack is AWS serverless: Lambda, Step Functions, DynamoDB** — the team kit's Lambda-first patterns (`build-ai-agents`, `build-rag-systems`) reflect it. Values A2A-protocol fluency and working through existing agent frameworks rather than from scratch. Their best performer "thinks in systems, not tasks." Enterprise clients (insurance, capital markets).

## Concept
Build a **Chief of Staff Communication Agent**: connect all major comms channels (Gmail + other email, SMS, WhatsApp, X, LinkedIn) through a modular connector architecture; ingest messages/threads/participants/attachments into one centralized knowledge layer; RAG over comms history + Asana + user preferences + org knowledge; for every incoming communication produce a recommendation and a style-matched draft; link messages cross-channel by topic; create/update Asana tasks for follow-ups; require human approval before anything sends; track answered/unanswered against a <5-minute response goal; ship a dashboard UI (volume, status, overdue, pending approvals, channel breakdown, response times) plus views for recommendations and drafts-awaiting-approval; and expose the whole thing as a Cursor-usable agent. The README's acceptance criteria are the original requirements — all "done" claims trace back to them, never to a derived plan or todo list.

Central design tensions to resolve:
1. slowking hard-fails anything not publicly hosted, but this product holds private comms and OAuth tokens. The demo must run on **dedicated demo accounts** (fresh Gmail, sandbox SMS/WhatsApp numbers, test X/LinkedIn) — never Arthur's real accounts — with demo credentials shipped so slowking can log in and exercise it.
2. Channel breadth (6+ integrations) vs speed-of-delivery scoring. The connector architecture must make each additional channel cheap, and the demo needs "multiple channels" end-to-end — not necessarily every channel at production depth. Which channels get real APIs vs a webhook/inbound-gateway path is an Open question.

## Phasing / Status
Updated as work lands. **MAJOR PIVOT 2026-07-09** (Arthur): the product is a **multi-tenant, real-only** Chief of Staff — each user connects THEIR OWN real accounts and gets an isolated instance; a grader gets a separate demo account and never sees the owner's data. Superseded the earlier fixture-persona/simulated-send approach entirely.

DONE (spine v0, 2026-07-08, superseded shape): fixture connectors → store → RAG → brain → approval-gated send; Asana; 4-tab UI; Cursor agent package; hosted. Shadow ≈77/100 at that point.

DONE (multi-tenant refactor, 2026-07-09, local commit 6a8199a): real per-user isolation (owner_id + RLS + app-layer scoping, migration 007; **two-login isolation verified**); per-owner connector resolver replacing the global registry; retired all fixtures/FixtureConnector/telegram-bot/LinkedIn/persona; real-only channel scope locked. ruff clean, 5/5 tests.

Current work (in order):
1. **Web UI** for authed OAuth + 3 real channels — done; endpoints verified.
2. **owner_id NOT NULL** + connector_tokens owner-unique (migration 008, ships with deploy).
3. **Real Gmail send proof** — approval-gated approve→real delivery (never once fired; needs Arthur's OK on a test send).
4. **IMAP** connector + connect (needs Arthur's IMAP account + app-password).
5. **Telegram MTProto** (Telethon, personal account; needs api_id/api_hash + phone login).
6. **Demo tenant real data** — connect a demo Gmail + IMAP, seed real messages (needs a demo Google account).
7. **Deploy** — DONE on Azure Container Apps (isolation re-verified; IMAP send works). Remaining: add the Azure OAuth callback to the Google client (console); then demo video + PR. NOTHING pushes to the assignment repo until Arthur says so.

Channel scope (locked 2026-07-09): REAL & live = Gmail, 2nd-email (IMAP), Telegram (MTProto). Built-but-credential-gated (real code, awaiting creds/funding) = X DMs, Twilio SMS/WhatsApp. DROPPED = LinkedIn (no personal-messaging API).

## Tech stack
Proven choices only; open choices live in Open questions.
- **Python via uv** — Arthur decided (2026-07-08), overriding the kit's TypeScript mandate for this repo. uv discipline: `uv add`/`uv sync`/`uv run`, lock everything explicitly, never rely on a transitively-arrived package. Deviation bundle documented once: Python instead of TS, and LLM calls via the official `openai` package in Azure mode instead of the (TS-only) Vercel AI SDK. Rationale: owner preference + speed; exposure limited to kit-usage/implementation dimensions.
- **Azure OpenAI for LLM + embeddings** — Arthur has creds (2026-07-08). Powers recommendations, drafting, style-matching, RAG embeddings.
- **Supabase for the store** — Arthur has creds (2026-07-08). Postgres + pgvector: messages AND RAG vectors in one database; Supabase auth covers the demo login slowking needs.
- **Azure Container Apps for hosting** — one Docker container serves the FastAPI API + the static dashboard + the MCP surface (min-replicas=1 so the autosync loop + MCP session stay alive). `az containerapp up --source .`. Chosen over PaaS options that block outbound SMTP (that broke IMAP send-as-you). Known deviation from the kit's AWS+CDK path — accepted for speed; but Azure-serverless is Prism's own stack, so it aligns on host.
- **MCP for the Cursor agent** — "an agent usable directly in Cursor" is naturally an MCP server Cursor connects to; MCP is also how the agent retrieves RAG context and performs Asana actions. (A2A remains an option for agent→agent interop, per sibling; not an acceptance criterion here.)
- Secrets via env vars only — never in committed config. OAuth tokens live in the runtime's secret store, not the repo.
- macOS-local dev; **the demo runtime itself must be publicly hosted** — README requires a live/working runtime in the PR and slowking auto-fails localhost. Only channel *depth* may be simulated (sandbox numbers, fixture corpora); the app never is.

## Credentials & tooling (verified 2026-07-08; values live in `.env`, gitignored — see `.env.example`)
- **Azure OpenAI, chat** — key + endpoint (`foundry-memoirji-test.openai.azure.com`) sourced from cheleq. Deployments verified live: `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`. NOTE: this resource is NOT in any az-manageable subscription (external tenant; cheleq holds only the data-plane key) — nothing can be deployed/changed on it, only consumed.
- **Azure OpenAI, embeddings** — `text-embedding-3-small` (1536 dims) verified live on **`cheleq-alpha-3`** (cheleq rg, swedencentral) — already deployed, az-manageable, key via `az cognitiveservices account keys list`. Separate env vars: `AZURE_OPENAI_EMBED_*`.
- **Azure subscription** — az CLI logged in, "Microsoft Azure Sponsorship" default (5 more enabled subs). Azure hosting (Container Apps / Functions) is therefore viable for the Python backend.
- **Supabase** — account access token sourced from cheleq. Dedicated project created 2026-07-08: **`chief-of-staff-comms`** (ref `frhromdjjmczranjcnfz`, us-east-1, memoirji org), pgvector 0.8.2 enabled, REST verified. Hard rule from Arthur: NEVER touch the org's other projects (cheleq/kashi/polishy/etc.) — all work goes through this ref only. `.mcp.json` scopes the Supabase MCP server to this ref (restart session to connect it).
- **Netlify** — personal access token sourced from grandjury's `.mcp.json` (2026-07-08, per Arthur); verified against the API (account torezu@pm.me, 6 sites).
- **Twilio** — live SID/token/number exist in cheleq (`bot_lite/.env`); Arthur said leave it for now — do not copy until he says so.
- Key-shape note (learned 2026-07-08): new Supabase projects issue both legacy JWT keys and new `sb_publishable_`/`sb_secret_` keys; the REST root introspection endpoint answers only to service_role — a 401 with the publishable key there is normal, not breakage.

## Architecture
Grows as built. Intended flow:
```mermaid
flowchart TB
    subgraph CONN["Channel connectors — modular, one shared interface per provider"]
        GM["Gmail"]
        EM["Other email"]
        SMS["SMS"]
        WA["WhatsApp"]
        XC["X"]
        LI["LinkedIn"]
    end

    CONN --> ING["Ingest — normalize: message, thread,<br/>participants, attachments + provenance"]
    ING -.->|"raw responses cached"| RAW[("data/raw/")]
    ING --> STORE[("Message store<br/>centralized knowledge layer")]

    PREF["User preferences + org knowledge"] --> RAG
    STORE --> RAG[("RAG index")]
    ASYNC["Asana sync"] -->|"tasks, projects, comments"| RAG

    RAG --> BRAIN["Brain (per incoming message):<br/>recommendation + style-matched draft<br/>+ cross-channel topic links"]
    STORE --> BRAIN
    BRAIN -->|"writes back recs, drafts, links"| STORE
    BRAIN -->|"follow-up → create/update task"| ASYNC
    ASYNC <--> ASANA["Asana workspace"]

    STORE --> UI["Dashboard UI"]
    STORE --> MCP["Cursor agent (MCP server)"]
    UI --> GATE{{"HUMAN APPROVAL<br/>nothing sends without it"}}
    MCP --> GATE
    GATE -->|"approved"| SEND["Send via originating connector"]
    GATE -->|"low confidence"| UI
    SEND --> CONN
```
- One connector interface, one shared HTTP/auth path per provider: one fetch function, one error surface, one log shape.
- Raw provider responses are cached to `data/raw/` — never re-fetch what we already have; re-parsing is free, re-fetching burns rate limits.
- Every stored message carries provenance: channel, account, provider message id, fetched_at, raw-record pointer. This is what lets any recommendation or draft cite its sources.

## Verification discipline
- When listing options or feasibility ("we can / we could / we just need"), classify each claim: **verified** (I checked), **industry-default assumption**, or **unknown**. Label all items when mixed. A cheap curl or doc-read before claiming beats an "are you sure" cycle after. This matters double here: X and LinkedIn API access are famously constrained — never assume a scope or tier from memory.
- "Done" requires evidence: file:line for code claims, live query/API output for data claims. Traceability format when auditing: `Criterion | Evidence | PASS/FAIL/PARTIAL`. No percentage-complete claims, ever.
- **Ingest gate** — a channel connector is "working" only when: messages queried live from the store with correct thread/participant structure, per-account sync status reviewed, errors reviewed. Not when the sync script exits 0.
- **Send gate** — any send path is "working" only when demonstrated against a demo/sandbox account with the approval step observed in between. There is no headless send test against real accounts, ever.
- Pattern bug found in one place → `grep -r` the whole repo immediately; fix every occurrence.
- Validate against README acceptance criteria, not against a plan derived from them. (Origin: a validator once passed 4/5 requirements as 5/5 because it checked the implementation plan instead of the original spec.)

## External providers
- Never write a connector against a provider API from memory. WebFetch the docs or probe with a live call first to confirm endpoints, scopes, rate limits, and payload shapes. Same for Asana.
- Be polite: honor rate limits, back off on errors, cache aggressively.
- Document provider constraints here as discovered (this table is the deliverable behind the modular-connector and multi-provider criteria):

| Provider | Constraint | Noted |
|---|---|---|
| IMAP/SMTP (Zoho/Yahoo/iCloud) | Send-as-you needs the provider's SMTP (submission ports 465/587). **PaaS hosts block outbound SMTP** (Render blocks 465/587; confirmed by a 2-min hang while a local send delivered in 4.3s). **Azure Container Apps allows 465/587** (only port 25 blocked — verified via an ACI egress test) → IMAP send works there. iCloud/Outlook need STARTTLS:587; Yahoo/Zoho/Gmail use SSL:465. Outlook.com disabled basic-auth IMAP (OAuth-only) → not usable via IMAP. | 2026-07-09 |
| Resend / any HTTP email relay | Can only send from a **domain you've verified** on it — cannot send *as* an arbitrary user's IMAP address (e.g. `@zohomail.com`). So relays don't solve "reply from your account"; only the provider's own SMTP or OAuth-send-API does. | 2026-07-09 |
| Gmail | Send is an **HTTPS API** (not SMTP) → works on any host incl. SMTP-blocking PaaS, and sends *as the user*. This is why Gmail send worked on Render but IMAP didn't. | 2026-07-09 |

## Cost discipline
- Note per-run cost next to any design decision that introduces a paid API (Twilio, LLM calls, embeddings, hosting).
- No Opus-tier models inside the recommendation/drafting loop — context growth makes them ~5x the cost per run. Reserve heavy models for one-shot synthesis; the per-message loop runs on a cheap fast model until quality data says otherwise.
- Anti-fabrication gate: every recommendation, draft claim, and dashboard statistic carries a source (a message id, a query, an Asana URL) or is explicitly marked unverified.

## Engineering defaults
- **Mock-first dev loop**: fixture message corpora per channel behind a flag, so ingest, RAG, brain, and UI iterate fast without live provider calls or rate-limit burn. The fixture corpus doubles as demo seed data.
- **Defensive parsing**: never trust the shape of anything a provider webhook or an LLM returns. Malformed payloads go to an error sidecar (with the raw input); one bad message never kills a sync; one failed connector never aborts an ingest run.
- **Errors are loud, silence is a bug**: an empty sync from a connected account routes to a warning, not a quiet zero.
- Parallel connector syncs use `allSettled` semantics — collect failures, keep the rest.
- UI: lifted state, single source of truth, children controlled.
- Prompts use dynamic injection only — no hardcoded example names/content in prompt templates (see Learned the hard way).

## Working style
- Don't guess requirements when Arthur can be asked — he has the accounts, credentials, brand list, and Asana workspace this agent doesn't.
- A hedged musing ("i think X?" / "isn't Y?") is not a go. Wait for an action verb (do it, ship it, build it) before implementing anything from an exploratory discussion.
- Debugging >30 min without progress → stop and ask. Isolate the layer first (provider / data / code) before trying fixes.
- Don't add features, refactors, or abstractions beyond what the task requires. When Arthur says simple, build simple.
- Don't write a one-off script when an existing tool, MCP server, or kit skill already does it — check `../refs/soofi-xyz-team-kit/skills/` first; kit-usage is scored.
- Audit whole config files before commit — a partial edit can silently revert neighboring fields.
- Run the tests before every commit. No untested pushes.
- Sub-agents get narrow, checklist-shaped lookups only. Synthesis, design, and judgment stay in the main thread.
- No timeline projections ("week 1", "2-3 days"). Surface dependencies and blockers instead.

## Learned the hard way
Append one dated, quotable rule here in the same commit as the fix that taught it. Seeded from the ancestors:
- (inherited) Lock every dependency explicitly — uv installed `aiohttp` transitively, prod pip didn't, deploy "COMPLETE" claim preceded a `ModuleNotFoundError` crash.
- (inherited) Validate against the original requirements, never a derived plan — that's how 4/5 became "all five requirements successfully implemented."
- (inherited) Never emit an infra URL/identifier that merely looks right — a fabricated-but-plausible deploy URL made it into a report while the real one sat in the docs.
- (inherited) Editing one field of a synced config file re-applies every other field — read the whole file, then push.
- (inherited) Hardcoded examples in prompts leak into output — an interview bot greeted real users as "Sarah" from its few-shot examples. Dynamic injection only.
- 2026-07-08 — The Supabase **management-API** `/database/query` endpoint silently no-op'd DDL while returning `[]` "success": migrations 002 (`drafts.provider_message_id`) and 003 (`connector_tokens`) never persisted, and no test hit the successful-send path, so the missing column 500'd on the first real UI approval weeks later. Apply DDL via the Supabase **MCP `apply_migration`** (or verify with `list_tables`) — never trust a bare `[]` from the management API. And every write path needs a test that actually executes it, not just its guards.
- 2026-07-09 — **RLS "enabled" is not RLS "enforcing."** All tables had `relrowsecurity=true` and I logged "RLS on all tables" as done — but `pg_policies` was empty AND the backend read via service_role (which bypasses RLS) AND no table had an owner column. Net: any logged-in user got the global dataset. Enabling RLS with zero policies + a service_role backend is fake isolation. Isolation requires (a) an owner column, (b) app-layer owner filtering on every query (the real gate under service_role), (c) policies as defense-in-depth — and a two-login test that proves tenant A sees none of tenant B.
- 2026-07-09 — **A fixture demo read back as the real product and confused me for days.** FixtureConnector.send() wrote to `data/outbox/` and looked identical in the DB to a real send (status=sent, provider id); I couldn't tell real from fake in my own store. Lesson: don't build a simulation that is indistinguishable from the real thing at the data layer — either it's real, or it's unmistakably marked. Arthur's resolution: make everything real.

## Do NOT regress
Invariants to preserve; add as they're won.
- **Approval gate is absolute**: no code path sends a message without an explicit human approval recorded first. Not in tests, not in demos, not "just this once." This is both an acceptance criterion and the product's safety core.
- Demo runs on dedicated demo/sandbox accounts only — never Arthur's real Gmail/phone/X/LinkedIn. A runaway send on a real account is unrecoverable.
- No secrets/tokens in committed config — env-var references only. This repo becomes a public PR; OAuth token leakage here is a live-account compromise, not just hygiene.
- Provenance columns are never dropped "for simplicity" — source-backed recommendations are the product.
- The demo runtime must be publicly hosted at a reachable URL; demo login credentials ship with the PR (login-blocked = automatic 0/100 from the grader).
- **Every public surface is auth-gated — including MCP.** The hosted `/mcp/` endpoint exposes send/Asana-write tools; it requires a Supabase JWT or `MCP_AUTH_TOKEN`. (Origin: 2026-07-08 hosted slowking run found it wide open — access-boundary band crashed to 25%. Never mount a new surface without the gate.)
- **Tenant isolation is absolute.** The product is multi-tenant: every tenant-scoped row carries `owner_id`; every query filters by the authenticated user's id; every write stamps it. A login must NEVER read or act on another tenant's data. The backend runs as service_role (bypasses RLS), so the **app-layer owner filter is the real enforcement** — RLS policies (`owner_id = auth.uid()`) are defense-in-depth only. Adding an endpoint or MCP tool without owner-scoping is a privacy breach, not a bug. (Origin: 2026-07-09 audit — RLS enabled with ZERO policies + no owner column + service_role reads → any login saw the global dataset; would have shown Arthur's real inbox to the grader. Proven fixed: two-login test, demo sees 0 of Arthur's mail.)
- **Real or cut — never faked.** Every channel is a real integration owned by a tenant; there is no fixture connector and no simulated send. A channel we cannot make real (LinkedIn — no personal-messaging API) is DROPPED, not simulated. (Origin: 2026-07-09 — a fixture/persona demo kept getting mistaken for the real product; Arthur: "everything is real.")

## Design decisions
Dated one-liners, recorded after proven.
- 2026-07-08 — Python via uv for this repo (Arthur's call), accepting the kit's TS/Vercel-AI-SDK deviation as one documented bundle.
- 2026-07-08 — Azure OpenAI for LLM + embeddings; Supabase (Postgres + pgvector) as the single store for messages, vectors, and demo auth; Netlify for the dashboard UI.
- 2026-07-09 — **Host = Azure Container Apps** (Docker, `az containerapp up`), serving the API + static UI + MCP in one container (min-replicas=1 for the autosync loop + MCP session). Chosen because Render blocked outbound SMTP (broke IMAP send-as-you); Azure allows 465/587. Supersedes the earlier Netlify-UI / separate-backend split — the FastAPI app serves the static dashboard itself.
- 2026-07-08 — Dedicated Supabase project `chief-of-staff-comms` (ref `frhromdjjmczranjcnfz`) created in the memoirji org via management API; pgvector enabled; keys in `.env`; MCP server scoped to it in `.mcp.json`. Isolation from all other org projects is a standing rule.
- 2026-07-09 — **Multi-tenant, real-only** (Arthur). Per-user isolation via `owner_id` on every table + app-layer owner filtering + RLS defense-in-depth (migration 007). Each user connects their own real accounts; graders get a separate isolated demo account. Every channel is a real integration (no fixtures, no simulated send); LinkedIn dropped (no API). Two tenants provisioned: Arthur (arthurac@umich.edu, owns his real Gmail) + demo (owns the demo corpus). MCP surface scopes to `MCP_OWNER_ID`.

## Open questions
- Demo account inventory (needs Arthur, per channel):
  - Gmail — fresh demo Google account + Google Cloud OAuth app (test-mode consent screen suffices)?
  - Second email provider ("beyond Gmail" is an explicit AC) — Outlook vs a generic IMAP connector (cheapest honest satisfier)?
  - SMS/WhatsApp — Twilio creds exist in cheleq (`bot_lite/.env`); Arthur to approve reuse (or provision a separate number for this demo).
  - X — free API tier posts but cannot read DMs (verified constraint class; exact current tier limits to re-verify at build time). Paid tier available, or ship "connector built, constraint documented"?
  - LinkedIn — no official messaging API for personal accounts; plan is a gateway/mock connector proving modularity + documented constraint, unless Arthur knows otherwise.
- **Python backend host**: Azure subscription confirmed deployable (2026-07-08) — proposal: **Azure Container Apps with scale-to-zero** for the FastAPI backend (webhooks + API + MCP + scheduler in one container; wakes on HTTP; near-zero cost at rest). Not *pure* serverless: the MCP SSE surface and the sync scheduler want a process, not per-request functions. Confirm with Arthur before first deploy.
- Cursor MCP surface: remote MCP (SSE/HTTP) served by the Python backend — host follows the backend-host decision.
- Style learning: few-shot from sent messages at draft time vs a distilled style profile? Demo persona needs a seeded sent-history corpus (fresh demo accounts have none).
- Asana: which workspace for the demo; PAT (fastest) vs OAuth?
- ~~"Setup simple enough for non-technical users"~~ RESOLVED 2026-07-08 (Arthur's model): a **Connections page in the UI** — per-channel Connect buttons; OAuth where providers support it (Gmail via our registered Google OAuth app), credential-paste where they don't (IMAP host/app-password, Asana PAT), fixture channels labeled "demo mode". App-level provider registrations (Google OAuth app, Twilio account, Asana app) are product infrastructure owned by us — one registration serves every user; demo accounts are separate disposable identities used at demo time.
- Response-time tracking: what starts the <5-minute clock (ingest time vs provider timestamp) and what stops it (approval vs actual send)?
- Do we commit the meta kit (CLAUDE.md, .claude/) to the assignment repo? Sibling leans yes — Prism scores kit-usage and values codified skills — but Arthur decides.

## Not doing
- Auto-send without approval (see Do NOT regress) — even as an opt-in flag
- Real-account integrations for the demo — sandbox/demo accounts only
- Multi-tenant/team features beyond what the criteria require — single executive user until the demo passes
- Building all six channels to production depth before the spine (store → RAG → brain → approval) works end-to-end on one channel
- PBI/reflection/orchestration apparatus (see Rules)

## Recent milestones
- 2026-07-09 — **Migrated hosting Render → Azure Container Apps** (`az containerapp up --source .`, reusing the oracle sibling's `oracle-mcp-env` in rg `prism-demos`). Live at **https://cos-comms-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io** (min-replicas=1 for the autosync loop + MCP session; image in ACR `cad474061d7dacr`). Reason: Render blocks outbound SMTP so IMAP send-as-you hung; Azure allows 465/587 (verified). Post-migration on Azure: **isolation holds** (demo sees 0 of Arthur's mail) and **IMAP send works** — a real reply `democos@zohomail.com`→outlook via Zoho SMTP from Azure. Also this session: full UI redesign (Incoming kanban / Insights / spinning sync / all channels incl. X·SMS·WhatsApp connectable, LinkedIn unavailable); IMAP connector (Zoho connected live, fetch+triage+task proven); Asana tasks land in a "Chief of Staff" project. **Render fully retired** (service deleted + all config/refs removed from the repo). TODO for cutover: add the Azure OAuth callback to the Google client (console).
- 2026-07-09 — **Multi-tenant refactor** (local commit 6a8199a; NOT pushed/deployed). Reframe: workable multi-tenant product, not a demo — each user connects their own real accounts, graders get an isolated demo account. Audit exposed fake isolation (RLS enabled, 0 policies, no owner column, service_role reads → global dataset leak). Rebuilt: migration 007 (owner_id ×10 tables, RLS tenant_isolation, owner-scoped uniques, owner-filtered rag_search); backfill (Arthur owns his 500 real gmail, demo owns the rest); app-layer owner scoping through api/brain/ingest/rag/asana/send/mcp; per-owner connector resolver (`connectors/resolve.py`) replacing the global registry; OAuth state binds the tenant. **Two-login isolation VERIFIED: demo sees 96 msgs / 0 of Arthur's real senders; Arthur sees 499 real gmail.** Retired all fakes (6 fixtures, FixtureConnector, telegram bot, LinkedIn, persona/seed scripts, a committed sim-receipt). Channel scope locked real-only. Web UI updated for authed OAuth + 3 real channels. ruff clean, 5/5 tests (incl. new cross-tenant-send test). REMAINING: NOT-NULL hardening, real Gmail send proof, IMAP + Telegram-MTProto connectors, demo-tenant real data, deploy — most need creds/accounts from Arthur or his deploy-go.
- 2026-07-09 — Product-shape roll (Parts A–E) + hosted slowking (2 pillars). Runtime-verified ≈**77/100** (formal 0 until PR+video): functional 35/40, runtime&demo 10/20 (no video), evidence 9/12, **access-boundary 8/8** (MCP now auth-gated), impl 5/7, kit-usage 3/5 (top-of-band — real kit-format agent package). Delivered: 4-tab SPA (Needs You triage / Dashboard / Connections / People), honest <5-min data (0%→~55%), needs-context answer loop, cross-channel People (identity merge), Cursor deliverable = `gardevoir` agent + 3 skills + 4 slash commands + plugin manifests (kit format, cookbook-informed). Post-eval fixes: stateless HMAC OAuth nonce (restart-safe), MCP approvals upsert, **replaced 48 fixture Asana links (fake "live" URLs) with 8 real tasks** (anti-fabrication). Two hard gates remain: PR + demo video (held for Arthur).
- 2026-07-08 — Hosting first stood up (later migrated to Azure Container Apps, 2026-07-09 — see above). Auth gate shipped: Supabase JWT on all /api routes, login UI, demo user demo@meridianlabs.io (password in .env). MCP over streamable HTTP at /mcp/ (trailing slash required). X connector implemented, credential-gated (company will provide creds). Google: gcloud re-authed (arthur.cho@outlook.com); GCP project `cos-comms-demo` created + Gmail API enabled (utterpia project deliberately untouched — its production consent screen serves polishy/onlyhumans sign-in). Asana workspace being created by Arthur.
- 2026-07-08 — Full-fidelity slowking milestone run (2 independent pillars): formal 0/100 (local gates, expected), **shadow ≈66/100** (up from ≈48 baseline). Functional 30/40; strongest: dashboard 100%, recommendations 100%; weakest: reproducibility 25% (no setup docs), fixture-only channels. Pillar findings fixed same-day: concurrent 500 burst (supabase HTTP/2 retry — hammer test 42/42), send double-send race, approval re-decision 500, provider_message_id persisted (002), structured logging, ruff. Ruff lesson: autofix removed the load-bearing `boot` import (F401) — side-effect imports need `# noqa` armor.
- 2026-07-07 — Agent spawned per SPAWN.md; ancestors confirmed with Arthur (oracle-pipeline sibling + breeds/refs kit); business context read (Notion trial page + Email comms brief); slowking rubric confirmed shared with sibling; meta kit built (this doc, 3 skills).
- 2026-07-07 — Original job posting surfaced (dated): Architectural-Operator framing, agentic layering, AWS-serverless embedded stack — folded into Business context and the RAG/hosting open questions.

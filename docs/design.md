# Chief of Staff Communication Agent — Design

**Assignment:** Chief of Staff Communication Agent

## 0. Design principle — trace every decision to the acceptance criteria

Every decision below traces to an explicit assignment requirement. The design centers on the
outcomes the acceptance criteria and the demo criteria call for:

1. **Multi-channel ingestion into one knowledge layer** — email across brands, Gmail and additional
   providers, SMS, WhatsApp, X, LinkedIn, behind a modular connector architecture; messages, threads,
   metadata, participants, timestamps, attachments (README L13-L22, L43).
2. **RAG-backed context** — communication history, Asana context, user preferences, organizational
   knowledge; history preserved across platforms; related messages linked across channels
   (README L23-L24, L28, L44).
3. **A recommended action for every incoming communication** (README L26, L36, L45).
4. **Learned, style-matched draft replies** — "learn and apply each user's response style"
   (README L25, L27, L46).
5. **Approval before send, and a prompt for context when confidence is low** (README L31-L32, L47).
6. **Asana as the action sink** — link communications to tasks/projects/milestones/comments; create
   or update tasks for follow-ups (README L29-L30, L48).
7. **Answered-tracking and the <5-minute goal made visible** — volume, response status, overdue,
   pending approvals, channel breakdown, response-time metrics (README L33-L37).
8. **An agent usable directly in Cursor** with RAG retrieval, recommendations, drafts, and Asana
   updates (README L38-L40).
9. **Secure tokens and user-specific permission boundaries** (README L41-L42).
10. **Simple setup for non-technical users, documented** (README L12, L49) and **reusability within
    the soofi-xyz agent ecosystem** (README L50).

Each section names the criteria it satisfies.

## 1. Business intent (one sentence)

An executive sees every incoming communication from all connected channels in one place, approves a
context-aware draft written in their own style — with follow-ups landing in Asana — so that every
communication is answered in under five minutes.

The triage loop (ingest → recommend → draft → approve → send → track) is the product; channel
connectors feed it. Six connectors without a fast approval loop would miss the point.

## 2. Approach — modular connectors, one knowledge layer, one agent brain, hosted approval surface

```
Gmail · SMS/Twilio · IMAP/Outlook · WhatsApp · X · LinkedIn        [docs/decisions/channel-access-tiers.md]
   │  channel connectors — one interface: ingest / send? / identity  (L13-L20)
   ▼
INGEST PIPELINE — webhook Lambdas + scheduled poller → SQS (+DLQ) → processor
   │  normalize → NormalizedMessage (Zod) → dedupe (conditional write) → persist + embed + index  (L21-L22)
   ▼
KNOWLEDGE LAYER — OpenSearch (vector+hybrid) · Bedrock embeddings · DynamoDB (state/metadata) · S3 (raw)
   │  corpus: communications + Asana context + user preferences + org knowledge  (L23-L24, L28)
   ▼
AGENT BRAIN — Bedrock via Vercel AI SDK ToolLoopAgent (+ prompt caching) · AgentCore Memory · LangSmith
   │  tools: retrieveContext · recommendAction · draftReply · manageAsana  (L26-L27, L29-L30)
   │  style profile learned from the user's sent replies  (L25)
   ▼                                    ▼
DASHBOARD + API (Amplify web + tRPC/Lambda)      ASANA (link · create · update)  (L29-L30, L48)
   │  approval loop: approve/edit/reject · needs-context prompt · answered tracking  (L31-L37)
   │  send via the owning connector (Gmail threading headers · Twilio)  (L47)
   ▼
CURSOR — MCP server (stdio) → hosted API with per-user token; kit packaging  (L38-L40, L50)
```

Everything the kit already provides is used as shipped: `build-frontend-backends` (metagross) for the
Turborepo/Amplify/tRPC surface, `build-rag-systems` (alakazam, direct-build flow) for retrieval,
`build-ai-agents` (ash) for the agent runtime pattern, `manage-communication-activity` (chatot) for
the **send half** of the loop — send handoff, send idempotency, delivery-confirmation ingestion,
activity closure — and `apply-engineering-guidelines` + `integrate-ci-cd` for standards. What the
kit does not provide — inbound channel ingestion, the style learner, the MCP server — is built new,
following the closest kit pattern and recorded as an explicit decision. Every plan task carries a
`Drives:` attribution naming its driving agent and skill, with honest "no clean kit match"
declarations where the kit has no capability.

## 3. Channel connector architecture (README L13-L20, L43)

One TypeScript interface per channel: `ingest` (webhook handler and/or incremental poller), optional
`send`, and `identity` (map provider participants to internal accounts). Every connector emits the
same Zod-typed `NormalizedMessage`; nothing downstream knows channel specifics. Adding a channel is
adding a connector — the modular architecture required by L20 is the load-bearing capability.

Channel access levels differ by what each platform actually grants an integrator today; the tiers,
per-channel scope, and upgrade conditions are recorded in
`docs/decisions/channel-access-tiers.md`:

- **Live:** Gmail (OAuth, push/poll), SMS via Twilio, a second email provider via a generic IMAP
  connector (demoed on a named Outlook account — README L15's "providers", plural, honestly met),
  X public posts/mentions via xAI Live Search (read-only; data acquisition only — reasoning stays on
  Bedrock).
- **Sandbox:** WhatsApp via the Twilio sandbox (Meta business verification does not fit the
  assignment window).
- **Constrained:** LinkedIn (messaging API is partner-restricted) — notification-derived, read-only:
  runs **live** off real LinkedIn notification emails flowing through the email connector, with
  recorded fixtures for connector tests.

Multi-brand and multi-account support (L13) is a data-model property from day one: every message,
token, and query carries an `account_id`, and every read path enforces per-user account boundaries
(L42). `NormalizedMessage` evolves additively (versioned, additive-field policy), so existing
connectors never break when a new channel needs a new field.

## 4. Knowledge layer and RAG (README L21-L24, L28, L44)

- **Stores:** OpenSearch (vector + hybrid retrieval; production retrieval per `build-rag-systems`),
  Bedrock embeddings (Cohere Embed v4 if enabled in the target region, else Titan Text Embeddings v2),
  DynamoDB for message state/metadata/idempotency, S3 for raw artifacts and attachments (L21).
- **Corpus (L23):** communication chunks (deterministic ids; `text_for_embedding` /
  `text_for_context` split), Asana tasks/projects/milestones/comments, user preferences (style card +
  explicit preferences, seeded at setup and editable in the dashboard), organizational knowledge
  (Asana workspace structure + seeded org documents).
- **Cross-channel linking (L28):** metadata filters (participant, topic, project, Asana id) plus
  explicit link records — not embeddings alone. "Workstreams" (README L5) map to Asana
  projects/topics in this linking metadata. Conversation history is preserved per thread across
  platforms via `threadKey` (L24). Retrieval sits behind the `RetrievalIndex` interface and model
  ids are pinned in one config module, so the index or the embedding model can be swapped without
  touching consumers.
- **Local proof:** fixture corpus + Docker OpenSearch + SAM-local replay before AWS, per
  `build-rag-systems`; golden queries replayed against the deployed index.

## 5. Agent brain (README L26-L27, L29-L30, L32)

The runtime agent (`pidgeot` — collision-checked against the kit roster; a messenger-bird fit for a
message-delivery agent; runtime identifiers use `pidgeot-agent`, incl. `LANGSMITH_PROJECT`) keeps
the kit's agent interior
exactly as `build-ai-agents` prescribes it — Amazon Bedrock through the Vercel AI SDK
`ToolLoopAgent` with prompt caching, conversation history in AgentCore Memory behind a
`ConversationEventStore`, LangSmith telemetry — with one deliberate difference: the trigger is an
inbound communication, not an Asana task. The kit has no inbound-channel ingress; the ingress swap,
its idempotency consequences, and the alternatives considered are recorded in
`docs/decisions/email-ingress.md`.

- **Tools (one list, shared by the agent, the tRPC API, and the MCP server):** `retrieveContext`,
  `recommendAction`, `draftReply`, `manageAsana` (link / create / update).
- **Identity:** `sessionId` = thread key, `actorId` = sender; idempotency tokens derived from the
  provider message id.
- **Confidence gate (L32):** every recommendation/draft carries a confidence score; below threshold
  the communication enters `needs_context` and the dashboard prompts the user instead of pretending.

## 6. Style learning (README L25, L27, L46)

A per-user style profile learned from the user's own sent replies: embedded exemplars retrieved at
draft time plus an extracted style card (tone, typical length, sign-off, formality). Approved and
edited drafts feed back into the profile, so the system learns from every approval. Demo users are
provisioned with a realistic sent-history corpus so learned style is demonstrable, not asserted.

## 7. Approval workflow and answered-tracking (README L31-L37)

Server-side state machine per communication, DynamoDB conditional writes, business rules never in
the prompt or the frontend:

```
ingested → recommended → drafted → awaiting_approval → approved → sent → answered
                │                        │ edited → awaiting_approval
                │                        │ rejected → drafted (re-draft)
                │ dismissed (no reply needed — FYI, newsletters)
                │ needs_context → drafted (after the user supplies context)
```

- **Terminal states:** `answered` (entered on provider send confirmation) and `dismissed`. Both stop
  the overdue clock; "answered" tracking (L33) counts handled = answered ∪ dismissed.
- **The <5-minute goal (L34)** is supported, not enforced: a fast pipeline, response-time metrics at
  every transition, and an overdue flag on the dashboard — no SLA machinery.
- **Send** goes through the owning connector: Gmail API send with `In-Reply-To`/`References`
  threading (which also preserves history, L24), Twilio for SMS. Read-only channels (X, LinkedIn)
  produce drafts routed to a sendable channel or exported.

## 8. Dashboard, API, and Cursor (README L35-L40)

- **Dashboard (`apps/web`, Amplify):** volume, response status, overdue, pending approvals, channel
  breakdown, response-time metrics (L35); recommended-actions view (L36); drafts-awaiting-approval
  view with approve/edit/reject (L37); connect-channel wizard for non-technical setup (L12). Behind
  auth; reviewer credentials provided in the PR.
- **API (`apps/api`, tRPC on Lambda):** server-only reads/writes; every procedure enforces the
  account boundary; business logic lives in `packages/shared`, consumed identically by the API, the
  agent tools, and the MCP server.
- **Cursor (L38-L40):** an MCP server (stdio, npx-runnable) exposing the same four tools **plus the
  approval surface — `approveDraft` and `supplyContext`** — so the Cursor workflow serves its stated
  purpose (README L9: "final approval and additional context"), calling the hosted API with a
  per-user scoped token issued in the dashboard — the Cursor user gets RAG retrieval,
  recommendations, drafts, approval, context supply, and Asana updates without AWS credentials.
  Asana writes and `approveDraft` are confirm-gated. Packaged for the ecosystem (L50) the way the
  kit packages every agent: `agents/pidgeot.md` + `skills/use-pidgeot/` + an `mcp.json` entry,
  staged as a PR-ready patch to the kit repo per its new-agent checklist (roster row, sync outputs,
  manifest bump, validation pass).

## 9. Asana integration (README L29-L30, L48)

Asana REST API client: link communications to tasks, projects, milestones, and comments; create or
update follow-up tasks from a communication. Writes are approval-gated (dashboard action or
confirm-gated MCP call). Task descriptions carry the communication context and provenance
(channel, thread, timestamps), so the Asana side is self-explanatory.

## 10. Security and permission boundaries (README L41-L42)

- Every provider credential (Gmail OAuth refresh tokens, Twilio, Asana PAT, xAI key, per-user MCP
  tokens) lives in AWS Secrets Manager; account records reference secret ARNs; no secret in code,
  logs, or the client bundle.
- Per-user permission boundaries are enforced server-side on every read and write path — a user
  only ever sees and acts on their own connected accounts; verifiable with two demo users.
- Minimal OAuth scopes per provider; official APIs only.

## 11. Risks and operational constraints

- **Bedrock model access:** submit the Anthropic-on-Bedrock use-case form at bootstrap — accounts
  can start returning 403 after the first successful invoke; verify chat and embedding model
  availability in the target region before indexing (fallback: Titan Text Embeddings v2).
- **Gmail push:** API `watch` → Pub/Sub push needs a GCP project and OAuth consent/restricted-scope
  configuration; the scheduled incremental poller is the sanctioned fallback so ingestion never
  blocks on push setup.
- **Twilio account limits:** trial accounts restrict SMS recipients and prefix messages — verify at
  bootstrap; upgrade or document the constraint.
- **OpenSearch sizing:** a single-node `t3.small.search` domain serves the demo; documented as a
  deliberate cost/scope deviation from a production multi-AZ layout.
- **Amplify from a fork:** the dashboard deploys from this fork (the PR is the review artifact); if
  the GitHub connection fights the fork, fall back to a repo-less Amplify app with manual
  zip deployments — documented if used.
- **Reviewer access:** the demo workspace ships pre-connected (accounts already linked, data already
  flowing) with working credentials in the PR — the reviewer must never have to complete an OAuth
  flow to see the product working.
- **Demo data realism:** synthetic-but-realistic traffic is sent through the real channels to
  dedicated demo accounts continuously from the first channel deploy (a committed, runnable
  `just seed-demo` recipe) — real ingestion evidence at meaningful volume, no third-party PII.

## 12. Engineering standards

Per `apply-engineering-guidelines` + `integrate-ci-cd`: TypeScript throughout; all LLM interaction
through the Vercel AI SDK with Zod tool schemas; CDK as the only IaC (one root CDK app; stacks:
Ingest, Rag, Agent, Api, Amplify); region us-east-2 with `AWS_REGION` set explicitly; Powertools
(Logger + Tracer + Metrics) on every Lambda; business metrics per service (`MessageIngested`/
`MessageFailed` with a channel dimension, `AgentTurnProcessed/Failed`, `RequestProcessed/Failed`,
durations); a metrics registry (`cloudwatch-metrics.json`) and a CDK CloudWatch dashboard in-repo
(the org-central registry and main dashboard are not reachable from an external repo — adaptation
documented); PagerDuty Events API v2 on critical failure paths, key in Secrets Manager, paging gated
to the production flag; exactly one stateful alarm per DLQ (`ApproximateNumberOfMessagesVisible`,
Maximum, >0, 1/1 evaluation, `treatMissingData: NOT_BREACHING`) with ALARM **and** OK actions on one
SNS topic fanning out to email/chat/PagerDuty (PagerDuty subscription production-only; never
per-message alerts); 90-day log retention; `project_name` tags; no secrets or PII in logs; Vitest on
a ~70/30 unit/integration pyramid with `aws-sdk-client-mock`, real integrations in containers where
practical (Docker OpenSearch), and error-path coverage; responsive design tests for the dashboard
(the kit's breakpoint-config Playwright pattern, adapted — no Figma source); Prettier/ESLint/tsc; CI
via a `justfile` (format → lint → type-check → test → build → deploy) called by plain GitHub Actions
workflows in this fork — two documented adaptations: the shared org workflows are not accessible
from outside the org, and the prod-deploy trigger is the feature branch rather than `main` (this
fork's `main` mirrors the upstream assignment repo).

## 13. Deliverables

- PR to the assignment repo, including `docs/design.md`, `docs/plan.md`, and both decision records.
- Hosted runtime: the Amplify dashboard + API, pre-connected demo workspace, **working credentials
  in the PR**.
- Demo video: the full triage loop on live multi-channel data — ingestion (L43), RAG retrieval
  (L44), recommended actions (L45), style-matched drafts (L46), approval before delivery (L47),
  Asana task creation/update (L48) — with per-milestone clips recorded along the way as insurance
  and a committed demo storyboard.
- Setup documentation for non-technical users (L12, L49) and reviewer setup notes.
- Ecosystem packaging: `agents/pidgeot.md`, `skills/use-pidgeot/`, `mcp.json` entry (L50).
- Self-assessed with `slowking` before submission (per the assignment guidance).

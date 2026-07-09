# Chief of Staff Communication Agent — Solution

A unified assistant that pulls an executive's messages from every channel, understands them
with RAG, recommends the next action, drafts a reply **in the executive's voice**, links the
work to **Asana**, and gates every send behind human approval. Goal: every message answered in
under five minutes.

This document explains what was built, the design decisions, and how to run it. For the deeper
implementation walkthrough see **[RUNNING.md](./RUNNING.md)**; for the assignment's acceptance
criteria see **[README.md](./README.md)**.

---

## What it does (end to end)

```
 Gmail / X / WhatsApp ──▶ Connector (real SDK) ──▶ normalized Message
 Asana (real API)     ──▶ AsanaClient          ──▶ normalized Task
                                   │
                          Hybrid knowledge layer
                    graph (people, threads, identity)
                    + vector index (RAG: messages, tasks, style, prefs, org facts)
                                   │
        LangGraph brain:  retrieve → triage → decide → draft / delegate → execute
        grounded in hard facts, style-matched, A2A delegation to role agents
                                   │
        Next.js dashboard:  inbox · recommendation · draft · APPROVE gate · Asana write
                                   │
                          Cursor / MCP agent (same RAG + draft tools)
```

- **Modular connectors.** Every channel implements one `Connector` interface. Two are real
  (Gmail, X) plus WhatsApp inbound via webhook; adding a channel = implement the interface.
  Each connector uses the **real provider SDK** (`google-api-python-client`, `tweepy`,
  `python-asana`) with only the base URL + credentials swapped between mock and real.
- **Knowledge layer + RAG.** A graph links people, threads, and cross-channel identities; a
  vector index retrieves message history, Asana tasks, the owner's style corpus, preferences,
  and org facts at draft time.
- **Agent brain.** A LangGraph pipeline recommends an action (13-action taxonomy + Asana op),
  drafts in the owner's learned style, or delegates to a role agent (engineering / CFO /
  recruiter / scheduler) over agent-to-agent HTTP. An LLM-as-judge eval scores it against a
  labeled scenario set and a rules baseline.
- **Approval gate.** Nothing sends without explicit owner approval. The role boundary is
  enforced server-side in the API, not just in the UI.
- **Style control.** Style is learned automatically from the owner's sent mail, and the
  **Style page** lets the owner pin voice, sign-off, do/don't rules, and example messages that
  are injected verbatim into every draft.

---

## Real vs mock (mixed mode)

One flag, `MODE`, plus per-channel base URLs decide whether each connector talks to a local
mock or the real provider. The current demo runs **mixed**:

| Channel | Default | Notes |
|---|---|---|
| **Asana** | **REAL** | The demo scenario (6 projects, 33 tasks, 7 milestones) is seeded into a real workspace via `python -m cos.scripts.seed_asana`. Reads and writes are live. |
| Gmail | mock (real-ready) | Real mode needs a Google OAuth Desktop client + refresh token; mint with `python -m cos.scripts.mint_gmail_token`. |
| X | mock (real-ready) | Real mode needs OAuth1 user context. |
| WhatsApp | mock (real-ready) | Inbound is webhook-push; run `cos/webhooks/whatsapp` behind a public HTTPS URL. |

The mock servers emulate the **native provider API shapes**, so the same connector code is
exercised in both modes. Flipping a channel to real is only a base-URL + credential change in
`.env` — no code change. (Going real on Asana surfaced and fixed three real bugs the lenient
mock had hidden: container-less task creation/listing, and milestone detection via
`resource_subtype`.)

---

## How to run

### Option A — one command (Docker Compose)

```bash
export OPENAI_API_KEY=sk-...            # the brain runs on a real LLM
docker compose up --build
```

Brings up: provider mocks (:8900), FastAPI app API (:8000), Postgres (:5432), the Next.js web
app (:3000), the Gradio RAG explorer (:7860), and four A2A role agents (:8901–8904). The web
image runs `prisma db push` + seed on start, so **http://localhost:3000** is ready with logins
and all connections in mock mode.

### Option B — local dev

```bash
# Python engine
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,agents,ui]"
cp .env.example .env
python -m cos.fixtures.generate          # writes cos/fixtures/data/*.json

# 1) provider mocks
uvicorn cos.mocks.app:app --port 8900
# 2) app API (needs OPENAI_API_KEY)
export AUTH_JWT_SECRET=$(openssl rand -hex 32)
uvicorn cos.api.app:app --port 8000
# 3) web app (Node 20+, Postgres in DATABASE_URL)
cd web && cp .env.example .env.local && npm install && npm run setup && npm run dev
```

Open **http://localhost:3000**.

### Demo credentials

| Role | Login | Can |
|---|---|---|
| **Owner** | `owner` / `owner1234` | approve + send, edit connections, edit style |
| **Demo / grader** | `demo` / `demo1234` | read-only — no OAuth required of the grader |

The `AUTH_JWT_SECRET` must match between the web app and the API (the web login mints the
session JWT the API verifies).

---

## Enabling real data

**Real Asana** (already active in this demo):

```bash
# .env: ASANA_TOKEN=<personal access token>, ASANA_WORKSPACE_GID=<gid>,
#       ASANA_BASE_URL=https://app.asana.com/api/1.0
python -m cos.scripts.seed_asana          # idempotent; --dry-run to preview
```

**Real Gmail** (the real-inbox ingestion path):

```bash
# create a Google OAuth "Desktop app" client, download client_secret.json to the repo root
python -m cos.scripts.mint_gmail_token    # opens consent, prints the .env values
# paste GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN and
# set GMAIL_BASE_URL=https://gmail.googleapis.com
```

---

## The Style page

`/style` (owner-only editing; demo is read-only). Shows the profile learned from sent mail and
lets the owner pin:

- **Voice** and **Sign-off** — short free-text.
- **Rules** — explicit do/don't the draft obeys verbatim (e.g. "no em dashes", "lead with the point").
- **Example messages** — canonical messages in the owner's voice; these lead the few-shot at draft time.

Overrides persist to `knowledge/style_overrides.json`, merge into the learned `StyleProfile`,
and take effect on the next draft (the profile cache is dropped on save). Style transfer is
in-context (few-shot imitation), not a fine-tuned model.

---

## Testing

122 tests across 15 files — unit, connector wire-contracts, full-corpus invariants,
property-based fuzzing (Hypothesis), robustness against malformed payloads, retrieval quality,
and an end-to-end ingest → retrieve → recommend → execute pipeline. An eval harness scores the
LLM brain against labeled scenarios + an unseen "tricky" set versus a rules baseline.

```bash
pytest -q            # 122 passing
make eval            # competency scoreboard (starts its own mock)
```

---

## Security & boundaries

- Secrets live only in `.env` / deploy env (gitignored, alongside `client_secret*.json` and
  token files). No credential is committed.
- The owner-only permission boundary is enforced in the API layer (JWT role claim), so the
  read-only demo/grader account cannot send or mutate — the graded access-boundary requirement.
- Mock-only is the default so a grader never has to complete an OAuth flow.

---

## Reusability

Built on the patterns in the `soofi-xyz-team-kit` (RAG drafting, editorial style, Asana
integration) and exposes a Cursor/MCP agent over the same RAG + draft tools, so the solution
plugs into the existing agent ecosystem.

# Running the Chief of Staff Agent (Phase 0–3)

This phase delivers the **data + ingestion + Asana foundation**: realistic multi-channel
test data, local mock servers that emulate the real provider APIs, and connectors built on
the **real client SDKs** pointed at those mocks. A single `MODE` flag flips the same code to
production.

## What's built so far
- **Test data** — the "Series A closing week" scenario: 118 messages across Gmail, X, WhatsApp;
  42 contacts; 33 Asana tasks incl. 7 milestones; 16 **labeled** scenarios (expected action +
  Asana op + priority) plus procedural bulk. See [PRD.md](./docs/PRD.md).
- **Mock servers** (FastAPI) emulating Gmail v1, X v2, WhatsApp Cloud API, Asana REST
  (tasks, milestones, comments, assign, delete).
- **Connectors** using `google-api-python-client`, `tweepy`, `httpx`, `python-asana` — each
  pointed at the mock via a swappable base URL. Adding a channel = implement `Connector`.
- **Knowledge layer (hybrid RAG)** — a graph (entities + identity edges) + a vector index
  (keyless TF-IDF for dev, OpenAI in prod). See [ONTOLOGY.md](./docs/ONTOLOGY.md).
- **Evaluation harness** — competency-question eval scored against the labeled scenarios; a
  rules baseline the Claude brain must beat. See [EVAL.md](./docs/EVAL.md).

Still to come (next phases): the Claude "recommend + draft in your style" brain, approval
dashboard UI, Cursor/MCP agent, deployment.

## Baseline scoreboard (`make eval`)
```
Q9  action accuracy        16/16   Q9  asana-op accuracy   13/16
Q11 NEEDS_INPUT  F1  1.00   Q7  cross-channel F1  1.00
Q8  task/milestone hit@1  8/8      Q4  context recall  1.00
Q3  stale-outbound found 1         Q12 dashboard counts (118 msgs, 7 milestones)
```

## Setup
```bash
python3.11 -m venv .venv && source .venv/bin/activate   # or: uv venv --python 3.11
pip install -e ".[dev]"                                  # or: uv pip install -e ".[dev]"
cp .env.example .env
python -m cos.fixtures.generate                          # writes cos/fixtures/data/*.json
```

## Run
```bash
# 1) start the provider mocks (leave running)
uvicorn cos.mocks.app:app --port 8900

# 2) in another shell:
python -m cos.scripts.ingest       # pull + normalize from all 3 channels
python -m cos.scripts.asana_demo   # tasks / milestones / comments / assign / delete
python -m cos.eval.harness         # competency eval scoreboard (starts its own mock)
python -m cos.scripts.facts_demo   # hard facts for the hero scenarios
pytest -q                          # 95 tests across 15 files (see Testing below)
```

`make fixtures | seed | mocks | ingest | asana-demo | eval | ui | test` wrap the same commands.
The eval harness starts the mock itself, so `make eval` needs no running server.

## Explore the RAG + graph (Gradio UI)
```bash
pip install -e ".[ui]"
python -m cos.scripts.seed              # (re)generate + upload the dataset
uvicorn cos.mocks.app:app --port 8900   # terminal 1
python -m cos.ui.app                     # terminal 2 -> http://localhost:7860
```
Three tabs: **Analyze a message** (pick a scenario or type a custom one → hard facts,
baseline recommendation, retrieved context, and the graph neighborhood image),
**Vector search** (query the index by kind), and **Graph explorer** (a person's ego-network).

## Multi-agent brain (LangGraph + A2A + eval-driven)
The recommendation/draft "brain" is a **LangGraph** pipeline on **OpenAI gpt-5.1**, grounded in
the hybrid RAG at every step, with **agent-to-agent (A2A) delegation over HTTP** and an
**LLM-as-a-judge** eval.

- **Flow:** RAG (hard facts + tasks + cross-channel + prefs + org) → triage → decide (13-action
  taxonomy + Asana op) → draft (in your **learned style**) or **A2A delegate** → execute.
- **Style learning** (`cos/agents/style.py`): distills your sent corpus into a `StyleProfile`
  (it learned *"avoid em dashes, keep it concise"*); drafts condition on it; `style_score` grades it.
- **A2A** (`cos/agents/a2a/`): `engineering / cfo / recruiter / scheduler` run as HTTP services
  with agent cards at `/.well-known/agent-card.json`; the orchestrator delegates via JSON-RPC
  `message/send`. Role→tool permission boundaries live in `cos/agents/roles.py`.
- **Eval-driven** (`cos/eval/agent_harness.py`, `judge.py`): runs the brain over the labeled
  scenarios + unseen tricky set, an LLM judge scores action / op / delegation / facts / policy /
  style / hallucination, compared to the rules baseline. Traces saved to `runs/agent_eval_traces.jsonl`.

```bash
pip install -e ".[agents]"                              # langchain, langgraph, langchain-openai
# keys load from the ArgminAI platform .env (OPENAI_API_KEY, OPENAI_MODEL=gpt-5.1); never committed
uvicorn cos.mocks.app:app --port 8900                   # terminal 1
python -m cos.agents.a2a.launch engineering             # (+ cfo/recruiter/scheduler) or via compose
python -m cos.eval.agent_harness                         # AGENT_EVAL_LIMIT=5 for a fast run
```
Agent tests run **keyless** (LLM mocked); the real-LLM smoke is behind `RUN_LLM=1`.

## Web app — login, chat, per-channel context, approval gate (Next.js + FastAPI)
The product UI (`web/`, Next.js/TypeScript) + a JSON/SSE API (`cos/api/`, FastAPI) on top of the
same engine. Username/password auth (Postgres), a chat dialog that streams the brain's
**thoughts → tool calls → actions**, Gmail/X/WhatsApp/Asana context panels, and an
**approve/edit/reject-before-send** gate. Roles: **owner** (seeded `owner/owner1234`) can approve +
send + change connections; **demo/grader** (`demo/demo1234`) is read-only. A **Connections** page
manages the four providers with a **Mock-only** default so a grader never touches OAuth.

Local dev:
```bash
# 1) provider mocks + the app API
uvicorn cos.mocks.app:app --port 8900                    # terminal 1
export AUTH_JWT_SECRET=$(openssl rand -hex 32)           # must match the web app
uvicorn cos.api.app:app --port 8000                      # terminal 2  (needs OPENAI_API_KEY)
# 2) the frontend (needs Node 20+ and a Postgres in DATABASE_URL)
cd web && cp .env.example .env.local && cp .env.example .env
npm install && npm run setup                             # prisma generate + db push + seed
npm run dev                                              # -> http://localhost:3000
```
The API verifies the same `AUTH_JWT_SECRET` the web app signs sessions with, and enforces the
owner-only boundary server-side (not just in the UI). The chat runs the real gpt-5.1 brain, so the
API process needs `OPENAI_API_KEY`.

## One-command demo (Docker Compose)
```bash
export OPENAI_API_KEY=sk-...          # required by api + the a2a services
docker compose up --build
```
Services: `mocks` (:8900), `api` (FastAPI app API, :8000), `postgres` (:5432), `web`
(Next.js, **:3000**), `ui` (Gradio explorer, :7860), and the four A2A role agents (:8901–8904).
The web image runs `prisma db push` + seed on start, so **http://localhost:3000** has the
`owner/owner1234` and `demo/demo1234` logins ready with all four connections in mock mode.
(The older Gradio explorer at :7860 remains for RAG/graph inspection.)

## Testing (95 tests, 15 files)
Wide and deep, not happy-path:
- **Unit / mock shapes / connectors** — provider mocks + real-SDK connectors.
- **Edge cases** — send paths, identity variants, Asana errors, rule precedence.
- **Full-corpus invariants** — classifier + retriever over all 147 messages; unique ids,
  tz-aware, single-channel threads, valid enums, determinism at scale, adversarial suffixes.
- **Property-based (Hypothesis)** — fuzz classifier, deadline regex, identity norm, embeddings.
- **Fixture integrity** — the ground truth itself: valid enums, linked work exists, links span
  channels, milestones flagged, relationships complete.
- **Robustness** — malformed provider payloads (missing headers, bad base64, missing users).
- **Wire contracts** — every real API route reachable on the mock; tweepy + WhatsApp SDKs emit
  the exact real paths in `MODE=real` (so real mode is trustworthy).
- **Mode switching** — base URLs, tweepy redirect, and embedder all flip on `MODE`.
- **Serialization** — every model round-trips losslessly through JSON.
- **Retrieval quality** — cosine self-similarity/symmetry, relevant task ranks first, graph
  consistency, deadline-regex ReDoS safety.
- **End-to-end pipeline** — ingest → retrieve → recommend → execute each Asana op → verify.
- **Generalization benchmark** — 10 unseen "tricky" messages; the rules baseline scores 6/10
  (vs 16/16 on tuned scenarios), quantifying the gap the LLM brain must close.

Three real bugs were found and fixed by these: X-send OAuth, Asana bad-gid crash, Gmail
malformed-base64 crash.

## Mock vs real
`cos/config.py` reads `MODE` and the per-channel base URLs. In `MODE=mock` the SDKs talk to
`localhost` with dummy creds. Set `MODE=real`, point the base URLs at the real API roots
(`https://gmail.googleapis.com`, `https://api.twitter.com`, `https://graph.facebook.com`,
`https://app.asana.com/api/1.0`) and supply real credentials in `.env` — the connector and
mapping code is unchanged. What each channel needs in real mode:

- **Gmail** — a Google OAuth "Desktop app" client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)
  and a user refresh token (`GOOGLE_REFRESH_TOKEN`). Mint it once with the consent flow, e.g.:
  ```python
  from google_auth_oauthlib.flow import InstalledAppFlow
  scopes = ["https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send"]
  creds = InstalledAppFlow.from_client_secrets_file("client_secret.json", scopes).run_local_server()
  print(creds.refresh_token)   # -> GOOGLE_REFRESH_TOKEN
  ```
  The connector derives (and auto-refreshes) the access token from it at request time.
- **X** — OAuth1 user context (`X_CONSUMER_KEY/SECRET`, `X_ACCESS_TOKEN/SECRET`) is required
  for DMs and posting; the app-only `X_BEARER_TOKEN` covers public mention reads. Mentions also
  need an API tier that grants the mentions endpoint.
- **WhatsApp** — inbound is **push, not pull**: the Cloud API has no list endpoint. Run the
  webhook receiver `uvicorn cos.webhooks.whatsapp:app` behind a public HTTPS URL, register it
  with Meta using `WHATSAPP_VERIFY_TOKEN`, and set `WHATSAPP_APP_SECRET` so the receiver can
  validate the `X-Hub-Signature-256` on each delivery. Deliveries buffer to
  `cos/fixtures/data/whatsapp_inbox.json` (override with `WHATSAPP_INBOX_PATH`); the connector
  drains that buffer. The send path (POST `/<version>/<phone_id>/messages`) is already real.
- **Asana** — a personal access token (`ASANA_TOKEN`) and `ASANA_WORKSPACE_GID`; no OAuth dance.
  The SDK client already targets the real host once `ASANA_BASE_URL` is the real root.

## Architecture
```
provider mock (FastAPI, native API shapes)
      ▲  real SDK over HTTP (base URL swapped by MODE)
Connector (gmail / x / whatsapp)  ──►  normalized Message
AsanaClient (python-asana)        ──►  normalized Task
```

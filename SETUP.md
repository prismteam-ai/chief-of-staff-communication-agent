# Setup

The Chief of Staff Communication Agent: multi-channel inbox → RAG context →
per-message recommendation + style-matched draft → **human approval** → send via
the originating channel, with Asana linking, an ops dashboard, and a Cursor
(MCP) agent surface. `README.md` is the assignment contract; this file is how
you run the system.

## Try the hosted demo (no setup)

1. Open the demo URL (shipped with the submission) and sign in with the demo
   credentials provided alongside it.
2. You land on the dashboard: volume, response status, overdue (>5 min),
   pending approvals, per-channel breakdown, response times.
3. Scroll to **Drafts awaiting approval** — approve or reject a draft; approving
   sends via the originating channel connector and flips the message to
   answered (watch the tiles update).
4. Connect the same runtime in Cursor: see `docs/cursor-setup.md` (hosted MCP
   endpoint at `<demo-url>/mcp/` (note the trailing slash)).

## Run it yourself

Prereqs: [uv](https://docs.astral.sh/uv/), a Supabase project, Azure OpenAI
deployments (a chat model + `text-embedding-3-small`).

```bash
cp .env.example .env          # fill in Supabase + Azure values
uv sync

# 1. schema (run each file against your Supabase project's SQL editor or psql)
#    migrations/001_init.sql, migrations/002_provider_correlation.sql

# 2. seed knowledge + demo login
uv run python scripts/seed_knowledge.py
uv run python scripts/create_demo_user.py demo@example.com <choose-a-password>

# 3. (optional) grow the fixture corpus — deterministic, idempotent
uv run python scripts/expand_fixtures.py --now "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"

# 4. run
uv run uvicorn cos_agent.api:app --port 8000
# open http://127.0.0.1:8000 and sign in with the demo user
# first action: click "Sync channels" to ingest + index + process

# 5. tests
uv run pytest -q
```

## Channels: fixture mode vs live

Every channel implements one `Connector` protocol (`src/cos_agent/connectors/base.py`).
Without provider credentials a channel runs on its committed fixture corpus
(`data/fixtures/<channel>.json`) and sends land in `data/outbox/<channel>/` as
auditable artifacts — the full loop works end to end. Setting a channel's
credentials in `.env` swaps in its real connector at boot (see `boot.py`):

| Channel | Live when set | Status |
|---|---|---|
| x | `X_USER_ACCESS_TOKEN`, `X_SELF_USER_ID` | implemented; DM read requires a paid X API tier — credentials to be provided |
| asana | `ASANA_ACCESS_TOKEN`, `ASANA_WORKSPACE_GID` | implemented (tasks + linking + RAG indexing) |
| gmail | Google OAuth app credentials | connector pending OAuth app registration |
| email (IMAP) | IMAP host/user/app-password | connector pending demo mailbox |
| sms / whatsapp | Twilio credentials | connector pending account approval |

## Deploy (Azure Container Apps)

The runtime is a single Docker container (see `Dockerfile`) on Azure Container Apps —
chosen because it allows outbound SMTP (submission ports 465/587), which IMAP
send-as-you needs and which most PaaS hosts block.

```
az containerapp up \
  --name cos-comms-agent --resource-group <rg> \
  --source . --ingress external --target-port 8000 \
  --env-vars SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… AZURE_OPENAI_… \
             GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… MCP_AUTH_TOKEN=… \
             MCP_OWNER_ID=… AUTOSYNC=1 AUTOSYNC_INTERVAL_S=300
# then, once the FQDN is known:
az containerapp update -n cos-comms-agent -g <rg> \
  --set-env-vars GOOGLE_REDIRECT_URI=https://<fqdn>/api/oauth/google/callback PUBLIC_HOST=<fqdn> \
  --min-replicas 1   # keep one instance for the autosync loop + MCP session
```

`--min-replicas 1` matters: the sync scheduler and the MCP session live in the process,
so scale-to-zero would stop them. Add `https://<fqdn>/api/oauth/google/callback` to the
Google OAuth client's Authorized redirect URIs for Gmail connect.

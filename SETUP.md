# Setup

The Chief of Staff Communication Agent: multi-channel inbox → RAG context →
per-message recommendation + style-matched draft → **human approval** → send via
the originating channel, with Asana linking, an ops dashboard, and a Cursor
(MCP) agent surface. `README.md` is the assignment contract; this file is how
you run the system.

## Try the hosted demo (no setup)

1. Open the demo URL (in `docs/DEMO.md`) and sign in with the demo credentials
   provided separately with the submission.
2. **Incoming** — the triage board (New / Needs Context / Awaiting Approval /
   Done). Open a message → recommendation + style-matched draft → **Approve &
   Send** (the approval gate; it replies for real and flips to answered).
3. **Insights** — volume, response status, overdue, pending approvals, per-channel
   breakdown, response times, and People (cross-channel linking).
4. **Knowledge** — add a preference or org fact, then **↻ Regenerate** a draft to
   see it applied. **Connections** — connect channels yourself + generate a Cursor
   token.
5. Use it in Cursor: `docs/cursor-setup.md` (hosted MCP at `<url>/mcp/`, trailing
   slash required; auth via a per-user token generated in Connections → Connect Cursor).

## Run it yourself

Prereqs: [uv](https://docs.astral.sh/uv/), a Supabase project, Azure OpenAI
deployments (a chat model + `text-embedding-3-small`).

```bash
cp .env.example .env          # fill in Supabase + Azure values
uv sync

# 1. schema — apply migrations/*.sql in order against your Supabase project
#    (SQL editor / psql / Supabase MCP apply_migration)

# 2. create a login (Supabase auth user; this becomes an isolated tenant)
uv run python scripts/create_demo_user.py you@example.com <choose-a-password>

# 3. run
uv run uvicorn cos_agent.api:app --port 8000
# open http://127.0.0.1:8000, sign in, then Connections → connect a real account
# (Gmail OAuth or an IMAP mailbox). Connecting kicks a first sync automatically.

# 4. tests
uv run pytest -q
```

## Channels: real integrations only

Every channel implements one `Connector` protocol (`src/cos_agent/connectors/base.py`),
resolved **per tenant** from the credential that tenant connected (`connectors/resolve.py`) —
there is no fixture/simulated mode. A user connects each channel themselves from the
**Connections** tab (OAuth where the provider supports it, credential-paste otherwise);
the credential is stored per tenant in `connector_tokens` and never in the repo.

| Channel | How it connects | Status |
|---|---|---|
| gmail | Google OAuth (our app; user authorizes) | live & proven — read + send-as-you |
| email (IMAP) | IMAP host + app-password (paste) | live & proven — read + send-as-you |
| asana | Personal Access Token (paste) | live & proven — task create/update + due dates + linking |
| telegram | MTProto api_id/api_hash + a login session | built; activation gated by Telegram's own login validation |
| x | OAuth2 user token with DM scopes (paid X tier) | built; bring-your-own account |
| sms / whatsapp | Twilio SID + token + number | built; bring-your-own Twilio account |
| linkedin | — | cut: no public personal-messaging API |

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
             AUTOSYNC=1 AUTOSYNC_INTERVAL_S=300
# MCP tenancy is identity-driven — each user's Cursor token resolves to their own
# tenant (no MCP_OWNER_ID pin). MCP_AUTH_TOKEN is only a signing secret for OAuth state.
# then, once the FQDN is known:
az containerapp update -n cos-comms-agent -g <rg> \
  --set-env-vars GOOGLE_REDIRECT_URI=https://<fqdn>/api/oauth/google/callback PUBLIC_HOST=<fqdn> \
  --min-replicas 1   # keep one instance for the autosync loop + MCP session
```

`--min-replicas 1` matters: the sync scheduler and the MCP session live in the process,
so scale-to-zero would stop them. Add `https://<fqdn>/api/oauth/google/callback` to the
Google OAuth client's Authorized redirect URIs for Gmail connect.

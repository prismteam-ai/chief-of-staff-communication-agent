# Using the live app

Everything runs against the hosted runtime — nothing to install.

- **URL:** https://cos-comms-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io
- **Sign in:** demo credentials are provided **separately with the submission** (shared by email, not committed to this repo).
- It's multi-tenant and isolated: the demo login sees **only** the demo tenant's data — never any other user's. A different login yields entirely different, isolated data.

## What the demo account holds

A real inbox: professional email threads ingested live over **IMAP** (read + reply as the account), each triaged by the agent. Real data on a real connected mailbox — not a fixture corpus.

## The four tabs

**Incoming** — a triage board (New / Needs Context / Awaiting Approval / Done). Every incoming message gets a **recommended action** and a **style-matched draft**. Open one → the thread, the recommendation, the draft, with **Approve & Send / Edit / ↻ Regenerate / Reject**. When the agent isn't confident it shows an **answer box** instead of a draft — type the missing context and it re-drafts.

**Insights** — the ops dashboard: volume, response status, overdue, drafts awaiting approval, per-channel breakdown, and response-time metrics (incl. % answered < 5 min). Plus **People** — the same contact linked across channels, with their tasks.

**Knowledge** — teach the agent lasting **preferences** (standing rules, e.g. "keep replies to two sentences") and **organizational facts** (e.g. "our discounted rate is $150/hr"). Both feed every recommendation and draft. Add one, then **↻ Regenerate** a draft to see it obey.

**Connections** — connect channels yourself, each a real integration with step-by-step instructions: Gmail (Google OAuth), any other email (IMAP), Telegram, X, SMS/WhatsApp (Twilio), and Asana. Live channels can be **Reconfigured** or **Disconnected**. This tab also has **Connect Cursor** — generate a personal token to use the agent in Cursor (below).

## Suggested walkthrough (hits every "Demonstrate" criterion)

1. **Sign in** → public runtime + secure, per-user access.
2. **Incoming** → open the most urgent message: recommendation + style-matched draft, source-backed.
3. **Approve & Send** → the approval gate; it replies for real from the connected account, status flips to answered.
4. **Needs Context** item → the agent asks; you answer; it re-drafts.
5. **Knowledge** → add a preference or org fact → **Regenerate** a draft → it reflects it.
6. **Insights** → volume, overdue, % answered < 5 min, channel breakdown, People linking.
7. **Connections** → guided per-channel connect; an Asana task created from a message links back to a "Chief of Staff" project (with a due date when the message implies one).

## The agent in Cursor (MCP)

The same agent runs in Cursor over the hosted MCP endpoint (`<url>/mcp/`, trailing slash required). Auth is **identity-driven**: sign in to the web UI → **Connections → Connect Cursor → Generate token** → paste it into `~/.cursor/mcp.json` (see `docs/cursor-setup.md`). Cursor then acts only as that tenant — a different token sees only its own data; no token → 401. In Cursor: ask what's pending, have it draft a reply, create an Asana task, and approve & send — the approval gate holds there exactly as in the UI.

## Channel status (honest)

- **Live & proven:** Gmail (OAuth), other email (IMAP), Asana.
- **Built, bring-your-own-account:** X DMs, Twilio SMS/WhatsApp (your own paid provider account).
- **Telegram — built, could not be demoed live:** the connector (MTProto, personal account) is complete, but Telegram blocked creating an `api_id`/`api_hash` from my own account (my.telegram.org verification kept failing), and login codes for a personal MTProto session are invalidated server-side (anti-phishing). It activates the moment a valid session exists — the gate is Telegram's, not the code.
- **LinkedIn — not shipped yet:** no official public personal-messaging API; still evaluating a proper, compliant way to implement it (documented, not faked).

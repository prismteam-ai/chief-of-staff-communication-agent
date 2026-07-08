# How to use it + demo it

Everything here runs against the live site. Nothing to install.

- **URL:** https://cos-comms-agent.onrender.com
- **Sign in:** `demo@meridianlabs.io` / `Demo-HAM1Slj9dMnR`
- First load may take ~30–40s (free host wakes from sleep) — open it a minute
  before you record.

The demo persona is **Jordan Reeve**, an exec at Meridian Labs, with a week of
communications across 6 channels (gmail, other email, SMS, WhatsApp, X, LinkedIn).

---

## The four tabs (what each is)

**1. Needs You** — your daily workspace. Left = a prioritized queue (overdue >5 min
flagged red, most urgent first). Click any item → right pane shows the message, the
agent's **recommendation**, and a **style-matched draft** with **Approve & Send /
Edit / Reject**. When the agent isn't sure, it shows an **answer box** instead of a
draft — you type the missing context and it drafts.

**2. Dashboard** — volume, awaiting, overdue, drafts to approve, **% answered < 5 min**,
median response, and per-channel breakdown.

**3. Connections** — connect channels yourself: Gmail (OAuth button), paste-key
channels (IMAP/Twilio), and Asana shown **live**. Demo-mode channels are labeled.

**4. People** — every contact, merged across channels. Click one (try **Diego Fuentes**)
→ all their messages across gmail/sms/x/linkedin/email in one timeline, their topics,
and their **real Asana tasks**.

---

## Demo video script (~3 minutes, hits every "Demonstrate" criterion)

Re-seed for fresh <5-min data right before recording (see checklist below), then:

1. **(0:00) Sign in** — "Setup is a simple sign-in; the exec sees only their comms."
   → shows secure auth (criterion: simple setup, secure auth).
2. **(0:20) Needs You** — "One queue across all six channels, most urgent first."
   Click an overdue item. "The agent read the thread, pulled context, and recommends
   an action + a draft **in Jordan's voice**." → multi-channel triage, recommendation,
   style-matched draft.
3. **(0:50) Approve** — click **Approve & Send**. "Nothing sends without me — this is
   the approval gate." Show the counts drop. → approval before delivery.
4. **(1:10) Needs context** — pick an item showing the **answer box** ("Agent needs
   your context"). Type a one-line answer, click **Give context & draft**. "It asked
   instead of guessing; I answered, and it drafted." → prompt-for-context loop.
5. **(1:40) Dashboard** — "Volume, overdue, and the number that matters: **% answered
   within five minutes**." → the ops UI + the <5-min goal.
6. **(2:05) People** — click **Diego Fuentes**. "Same person across five channels,
   linked automatically, with his real Asana tasks." → cross-channel linking + Asana.
7. **(2:25) Connections** — "Non-technical setup: click Connect. Gmail opens Google's
   consent; Asana is live." → simple setup, integrations.
8. **(2:40) Cursor** — show `agents/gardevoir.md` + the slash commands, or (if wired)
   run `/triage` in Cursor. "The same agent, usable directly in Cursor over MCP." →
   Cursor-accessible agent.
9. **(2:55) Close** — "Every recommendation, draft, and task traces to a real source;
   nothing sends without approval."

Keep it to one clean take. If a free-host cold start stalls a click, pause and retry —
don't narrate the wait.

---

## Using the Cursor agent (optional in the video, good to show)

Add to Cursor (Settings → MCP) — replace the token with the one in the PR:

```json
{ "mcpServers": { "chief-of-staff-comms": {
    "url": "https://cos-comms-agent.onrender.com/mcp/",
    "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" } } } }
```

Then in Cursor chat: `/triage`, `/draft <message id>`, `/approve <draft id>`, or just
ask "what's pending?" See `docs/cursor-setup.md`.

---

## Pre-record checklist

1. `uv run python scripts/seed_realism.py` — refreshes "just arrived" messages so the
   <5-min gauge is live and some items sit in-window (not all overdue).
2. Open the URL once to wake the host (~30s).
3. Sign in, glance at each tab, confirm data looks right.
4. Record.

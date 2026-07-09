# Using the agent in Cursor

The Chief of Staff agent is delivered two ways over one backend:

- **Web dashboard** — the graphical triage/approval UI (see `SETUP.md`).
- **Cursor agent** — the same agent inside Cursor's chat, as a plugin: an agent
  definition (`agents/gardevoir.md`), skills (`skills/`), and slash commands
  (`commands/`), all wired to the hosted MCP server. This is the "agent that can
  be used directly in Cursor" and is authored in the soofi-xyz / Claude-ecosystem
  conventions so it is reusable within that agent ecosystem.

## What ships

```
agents/gardevoir.md              the Chief-of-Staff agent (persona, rules, approval gate)
skills/triage-communications/    survey + prioritize the inbox by the <5-min goal
skills/draft-and-approve/        draft in the exec's voice; send ONLY after approval
skills/link-to-asana/            turn a communication into a tracked Asana task
commands/{triage,draft,approve,context}.md   slash-command shortcuts
mcp.json + plugin.json           plugin manifest → the hosted MCP runtime
```

## Connect it in Cursor

Add the MCP server (Settings → MCP, or `.cursor/mcp.json` in any workspace). The
repo's `mcp.json` is the template — replace the token with the `MCP_AUTH_TOKEN`
shipped with the demo credentials:

```json
{
  "mcpServers": {
    "chief-of-staff-comms": {
      "url": "https://cos-comms-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/mcp/",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN from the demo creds>" }
    }
  }
}
```

(Trailing slash on `/mcp/` is required. A Supabase session JWT from `/api/login`
is also accepted in place of the static token.)

Cursor's agent now has these tools:

| Tool | What it does |
|---|---|
| `search_context(query)` | RAG over messages, org knowledge, preferences, Asana tasks |
| `pending_messages()` | inbound awaiting a response, oldest first |
| `message_context(id)` | thread + recommendation + drafts + topics for one message |
| `recommend_and_draft(id)` | next action + style-matched draft (+ Asana task if implied) |
| `approve_and_send(id)` | records YOUR approval and sends — only on explicit human approval |
| `reject_draft(id, note)` | reject with feedback |
| `answer_context(id, context)` | give the agent the context it asked for → it re-drafts |
| `create_asana_task(id, title, detail)` | create + link an Asana task |
| `dashboard_stats()` | volume, overdue, pending approvals, % within 5 min, channels |

## Use it

Natural language, or the slash commands:

```
/triage                     → what needs me, most urgent first
/draft <message id>         → style-matched draft (awaits approval)
/approve <draft id>         → approve & send a draft you reviewed
/context <message + answer>  → give the agent the context it asked for
```

Example transcript:

```
You:  /triage
Agent: 7 need you. Overdue: Priya (Atlas renewal, gmail+whatsapp), Sam (board deck)…
You:  what did we agree with Atlas on the SLA?
Agent: (search_context) 99.9% SLA, credits capped at 10%, QBRs from October — your
       07-06 reply + org note "atlas-account".
You:  /draft <priya's message id>
Agent: (recommend_and_draft) "Priya — yes on both. 99.9% SLA with credits works…"
You:  approve and send
Agent: (approve_and_send) Sent via gmail (id gmail-out-…). Message marked answered.
```

The approval gate holds here exactly as in the web UI: the agent never calls
`approve_and_send` without your explicit approval.

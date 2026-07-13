# Use the Chief of Communications agent in Cursor

The repo ships an MCP (Model Context Protocol) server that exposes the agent
layer as tools, so you can drive it straight from Cursor's chat.

## Setup

1. Make sure `.env` in this repo has `DATABASE_URL` (and optionally
   `MCP_USER_EMAIL` to pick which user's data to operate on — defaults to the
   first user).

2. Add the server to Cursor. Create (or edit) `.cursor/mcp.json` in the
   project you want to use it from — or `~/.cursor/mcp.json` for global use:

```json
{
  "mcpServers": {
    "chief-of-comms": {
      "command": "npx",
      "args": [
        "tsx",
        "--env-file=/ABSOLUTE/PATH/TO/ChiefOfStaffAgent/.env",
        "/ABSOLUTE/PATH/TO/ChiefOfStaffAgent/mcp/server.ts"
      ]
    }
  }
}
```

3. Reload Cursor (Settings → MCP → verify `chief-of-comms` shows a green dot).

## Tools

| Tool | What it does |
| --- | --- |
| `get_dashboard_stats` | Volume, answered/pending/overdue (5-min SLA), channel breakdown, response times |
| `list_unanswered` | Inbound communications still awaiting a response |
| `list_pending_approvals` | Drafts and Asana task proposals waiting for approval |
| `approve_action` | Approve & execute an action (optionally with an edited body) |
| `reject_action` | Dismiss a pending action |
| `run_agents_now` | Run the agent runtime immediately |
| `asana_status` | Live Asana project status report |

## Example prompts in Cursor

- "What communications are overdue right now?"
- "Show me pending approvals and approve the reply to jane@example.com"
- "Give me the Asana status for the Website Redesign project"
- "Run the agents and tell me what they drafted"

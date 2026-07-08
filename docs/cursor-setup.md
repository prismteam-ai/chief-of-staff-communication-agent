# Using the agent in Cursor

The Chief of Staff agent is exposed as an MCP server. In Cursor:

1. Settings → MCP → Add server, or create `.cursor/mcp.json` in any workspace:

```json
{
  "mcpServers": {
    "chief-of-staff": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/chief-of-staff-communication-agent", "cos-mcp"]
    }
  }
}
```

2. The repo's `.env` supplies credentials (Supabase, Azure OpenAI; Asana token optional — fixture mode without it).

3. Tools available to the Cursor agent:

| Tool | What it does |
|---|---|
| `search_context(query)` | RAG search across messages, org knowledge, preferences, Asana tasks |
| `pending_messages()` | Inbound communications awaiting response, oldest first |
| `message_context(message_id)` | Thread history + recommendation + drafts + topics for one message |
| `recommend_and_draft(message_id)` | Run the brain: next action + style-matched draft (+ Asana task if follow-up implied) |
| `approve_and_send(draft_id)` | Records YOUR approval and sends via the originating channel — only call on explicit human approval |
| `reject_draft(draft_id, note)` | Reject a pending draft with feedback |
| `create_asana_task(message_id, title, detail)` | Create + link an Asana task from a communication |
| `dashboard_stats()` | Volume, response status, overdue, pending approvals, channel breakdown |

Example prompts in Cursor chat:
- "What's pending in my communications? Prioritize by urgency."
- "What did we agree with Atlas on the SLA? Cite the sources."
- "Draft a reply to the board-deck email and show me before sending."
- "Approve draft <id> and send it."

When hosted, the same server is reachable over streamable HTTP at `/mcp` (see deployment docs).

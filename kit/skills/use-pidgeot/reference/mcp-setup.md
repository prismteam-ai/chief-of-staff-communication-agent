# Pidgeot MCP — Cursor setup

## Default: bundled with this plugin

This kit ships **`mcp.json`** at the plugin root. When you install or update the soofi-xyz
plugin and **reload Cursor**, the MCP server **`pidgeot`** is registered — but `COS_API_URL` and
`COS_API_TOKEN` are placeholders you MUST fill in yourself (unlike `elephant`, this server is
account-scoped per teammate, so there is no shared bundled config to fall back to).

**Install source:** the bundled `mcp.json` installs the pidgeot MCP server via `npx` from the
public GitHub repo `github:jzubielik/chief-of-staff-communication-agent`, running the built
`mcp/dist/server.js` entry (`bin: chief-of-staff-mcp`).

**MCP server name:** always `pidgeot`. The `pidgeot` agent and this skill call tools on that
server via `CallMcpTool` (`server`: `pidgeot`, `toolName`: e.g. `retrieveContext`).

## Teammate checklist

1. Node.js **22+** (`node -v`)
2. Plugin installed (see kit `README.md`) and Cursor reloaded after updates
3. **Get your token:** open the deployed dashboard (Amplify URL — see the assignment PR/operator
   notes), sign in, go to **Settings → MCP Tokens**, click **New token**, give it a label (e.g.
   "Cursor desktop"), and copy the token value shown. **It is shown exactly once** — if you lose
   it, mint a new one (the old one keeps working until explicitly revoked).
4. Edit `~/.cursor/mcp.json` (or the plugin's bundled entry, if your Cursor version lets you
   override per-server env) and fill in the two placeholders:

   ```jsonc
   {
     "mcpServers": {
       "pidgeot": {
         "command": "bash",
         "args": ["-c", "exec npx -y --package=github:jzubielik/chief-of-staff-communication-agent mcp"],
         "env": {
           "COS_API_URL": "https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com",
           "COS_API_TOKEN": "cos_mcp_<paste the token you minted in step 3>"
         }
       }
     }
   }
   ```

5. **Settings → MCP** — confirm **`pidgeot`** is listed and enabled (first start may take 1-3
   minutes while `npx` clones GitHub and runs the package build).
6. Reload Cursor (**Developer: Reload Window**, or fully restart if not detected).

## Verify connectivity

Ask the `pidgeot` agent (or call the tool directly) to run `retrieveContext` with any `accountId`
you own and a simple query (e.g. `"test"`). A healthy response returns `{ "hits": [...] }` (an
empty array is fine — it means the query matched nothing, not that auth failed). A `401`/
`UNAUTHORIZED` response means `COS_API_TOKEN` is missing, wrong, or revoked — re-mint from the
dashboard (step 3 above) and update `mcp.json`.

## Manual fallback (direct npx, no Cursor)

Smoke-test the server directly in a terminal (Ctrl+C to stop):

```bash
COS_API_URL="https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com" \
COS_API_TOKEN="cos_mcp_<your token>" \
npx -y --package=github:jzubielik/chief-of-staff-communication-agent mcp
```

A working server logs `[pidgeot-mcp] connected over stdio` to stderr and then waits on stdin for
JSON-RPC frames — this is expected; it is not meant to print anything to stdout on its own.

### Local development

When hacking on a local checkout of `chief-of-staff-communication-agent`, point `command` to
`node`/`tsx` against the local build/`mcp/src/server.ts`, set `cwd` to the repo, and use a
separate MCP entry (e.g. `pidgeot-local`) — do not change the bundled `pidgeot` entry other
teammates rely on. Example:

```jsonc
{
  "mcpServers": {
    "pidgeot-local": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/absolute/path/to/chief-of-staff-communication-agent/mcp",
      "env": {
        "COS_API_URL": "https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com",
        "COS_API_TOKEN": "cos_mcp_<your token>"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `COS_API_URL` | Yes | The deployed API's base URL (execute-api default domain — no custom domain owned by this project). |
| `COS_API_TOKEN` | Yes | Per-user token minted from the dashboard's Settings → MCP Tokens view. Never shared between teammates — each token scopes every call to the user it was minted for. |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `pidgeot` missing in MCP panel | Reload Cursor; confirm plugin path under `~/.cursor/plugins/local/` |
| `[pidgeot-mcp] COS_API_URL is not set...` in the MCP server log | Fill in `COS_API_URL` in the server's `env` block and reload |
| `[pidgeot-mcp] COS_API_TOKEN is not set...` in the MCP server log | Mint a token from the dashboard and fill in `COS_API_TOKEN` |
| Every tool call returns `401 UNAUTHORIZED` | Token is wrong/revoked — re-mint from the dashboard, update `mcp.json`, reload |
| `retrieveContext` always returns empty hits | Confirm `accountId` is one you actually own (Settings → Connected Channels shows your own `accountId`s) |
| `approveDraft`/`manageAsana` return `status: "preview"` even though you meant to send | You omitted `confirm: true` — re-invoke with it set, only after showing the user the exact content |
| First query is slow | `npx` clones GitHub and builds the package on first start — can take 1-3 minutes |
| GitHub install blocked (proxy/firewall) | Use a local checkout (`local development` section above) |

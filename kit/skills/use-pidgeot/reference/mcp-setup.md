# Pidgeot MCP — Cursor setup

## Default: bundled with this plugin — build from a local clone

This kit ships **`mcp.json`** at the plugin root. When you install or update the soofi-xyz
plugin and **reload Cursor**, the MCP server **`pidgeot`** is registered — but `COS_API_URL`,
`COS_API_TOKEN`, and the clone path are placeholders you MUST fill in yourself (unlike `elephant`,
this server is account-scoped per teammate, so there is no shared bundled config to fall back to).

**Install source: the monorepo, built from source — NOT `npx --package=github:...#path:mcp`.**
`mcp/` is a workspace member of the `chief-of-staff-communication-agent` monorepo
(`@chief-of-staff/mcp-server`, `"private": true` — never published to the npm registry). npm's
`github:owner/repo#path:subdir` install spec does **not** resolve a single subdirectory of a
monorepo the way it resolves a whole standalone repo — `npx --package=github:...#path:mcp` fails
outright. There is no separate single-package repo to point `npx` at either; the correct, working
setup is: clone the monorepo, install + build the workspace, then point Cursor at the built
`mcp/dist/server.js` directly with `node`.

**MCP server name:** always `pidgeot`. The `pidgeot` agent and this skill call tools on that
server via `CallMcpTool` (`server`: `pidgeot`, `toolName`: e.g. `retrieveContext`).

## Teammate checklist

1. **Node.js 22+** and **pnpm 9+** (`node -v`, `pnpm -v`)
2. **Clone and build once:**

   ```bash
   git clone https://github.com/jzubielik/chief-of-staff-communication-agent.git
   cd chief-of-staff-communication-agent
   pnpm install
   pnpm --filter @chief-of-staff/mcp-server build
   ```

   This produces `mcp/dist/server.js` — the actual stdio entry point Cursor runs. `mcp/` has no
   internal workspace dependency on the rest of the monorepo (only `@modelcontextprotocol/sdk` +
   `zod`), so this one `--filter` build is enough; you do not need to build `apps/`/`packages/`
   first. Re-run the same two commands (`pnpm install && pnpm --filter @chief-of-staff/mcp-server
   build`) after pulling an update to `mcp/`.

3. **Get your token:** open the deployed dashboard (Amplify URL — see the assignment PR/operator
   notes), sign in, go to **Settings → MCP Tokens**, click **New token**, give it a label (e.g.
   "Cursor desktop"), and copy the token value shown. **It is shown exactly once** — if you lose
   it, mint a new one (the old one keeps working until explicitly revoked).
4. Edit `~/.cursor/mcp.json` (or the plugin's bundled entry, if your Cursor version lets you
   override per-server env) and fill in the placeholders — the absolute path to step 2's clone,
   and your token from step 3:

   ```jsonc
   {
     "mcpServers": {
       "pidgeot": {
         "command": "node",
         "args": ["/absolute/path/to/chief-of-staff-communication-agent/mcp/dist/server.js"],
         "env": {
           "COS_API_URL": "https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com",
           "COS_API_TOKEN": "cos_mcp_<paste the token you minted in step 3>"
         }
       }
     }
   }
   ```

5. **Settings → MCP** — confirm **`pidgeot`** is listed and enabled (near-instant startup — it is
   already built; no clone/build happens at Cursor-launch time, unlike the old `npx`-at-startup
   approach).
6. Reload Cursor (**Developer: Reload Window**, or fully restart if not detected).

## Verify connectivity

Ask the `pidgeot` agent (or call the tool directly) to run `retrieveContext` with any `accountId`
you own and a simple query (e.g. `"test"`). A healthy response returns `{ "hits": [...] }` (an
empty array is fine — it means the query matched nothing, not that auth failed). A `401`/
`UNAUTHORIZED` response means `COS_API_TOKEN` is missing, wrong, or revoked — re-mint from the
dashboard (step 3 above) and update `mcp.json`.

## Manual fallback (direct `node`, no Cursor)

Smoke-test the built server directly in a terminal (from the clone's `mcp/` directory, after step
2's build; Ctrl+C to stop, or pipe a single JSON-RPC frame at it and let it exit on EOF):

```bash
COS_API_URL="https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com" \
COS_API_TOKEN="cos_mcp_<your token>" \
node dist/server.js
```

A working server logs `[pidgeot-mcp] connected over stdio` to stderr and then waits on stdin for
JSON-RPC frames — this is expected; it is not meant to print anything to stdout on its own. To
confirm the six tools are actually registered without a full Cursor round trip, pipe a
`tools/list` request at it:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  COS_API_URL="https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com" \
  COS_API_TOKEN="cos_mcp_<your token>" \
  node dist/server.js
```

### Local development

When hacking on a local checkout of `chief-of-staff-communication-agent`, run `pnpm --filter
@chief-of-staff/mcp-server start` (which runs `tsx src/server.ts` directly, no build step) instead
of pointing at `dist/`, and use a separate MCP entry (e.g. `pidgeot-local`) — do not change the
bundled `pidgeot` entry other teammates rely on. Example:

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
| `pidgeot` fails to start / MCP panel shows an error immediately | `args`' path doesn't point at a real `mcp/dist/server.js` — re-run the teammate checklist's step 2 build, then double-check the ABSOLUTE path in `mcp.json` (a relative path or a typo'd clone location is the most common cause) |
| `Cannot find module '.../mcp/dist/server.js'` | You haven't built yet, or built before pulling the latest `mcp/` source — re-run `pnpm install && pnpm --filter @chief-of-staff/mcp-server build` from the clone root |
| `git clone`/`pnpm install` blocked (proxy/firewall) | This setup requires network access to GitHub + the npm registry once, at clone/build time — there is no npx-at-Cursor-launch fallback (that was the broken `#path:mcp` approach this replaced) |

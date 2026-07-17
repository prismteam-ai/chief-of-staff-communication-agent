---
name: use-pidgeot
description: "Operating guide for using the Chief of Staff communication agent through the pidgeot MCP server in Cursor: RAG retrieval, recommended actions, drafted replies, confirm-gated send approval, missing-context supply, and Asana follow-up. Use when triaging inbound communications, reviewing/approving a draft, or linking a communication to Asana — via MCP tools only. Triggers on: pidgeot, chief of staff, communication triage, approve draft, recommend action, draft reply, supply context, manage asana."
---

# Use Pidgeot

This skill governs how to **operate the Chief of Staff communication agent through the MCP
server** bundled as `@chief-of-staff/mcp-server`
([source](https://github.com/jzubielik/chief-of-staff-communication-agent/tree/main/mcp)). The
agent reads/writes communication and Asana state by calling MCP tools that call the hosted,
account-scoped `chief-of-staff-communication-agent` API over HTTPS — never by shelling out to AWS,
DynamoDB, or OpenSearch directly.

Do **not** use this skill for:

- Browsing raw AWS resources for this project → use AWS CLI/console directly, outside this skill
- Bypassing the confirm gate on `approveDraft`/`manageAsana` → never call these with `confirm: true`
  without the user's explicit, unambiguous approval of the exact content

## Always read first

1. [`reference/mcp-setup.md`](./reference/mcp-setup.md) — Cursor MCP install, token minting, env vars
2. [`reference/tools-and-workflows.md`](./reference/tools-and-workflows.md) — tool catalog, confirm-gate protocol, decision tree

## Prerequisites

- **Node.js 22+**, **pnpm 9+**
- **Pidgeot MCP** via this plugin's bundled `mcp.json` (server name **`pidgeot`**), built from a
  local clone of `github:jzubielik/chief-of-staff-communication-agent` (`mcp/` is a monorepo
  workspace member — `pnpm install && pnpm --filter @chief-of-staff/mcp-server build` — never
  `npx --package=github:...#path:mcp`, which does not resolve a monorepo subdirectory). Full steps:
  [`reference/mcp-setup.md`](./reference/mcp-setup.md). Reload Cursor after installing/updating the
  kit or rebuilding; confirm **`pidgeot`** is enabled under MCP settings.
- **Required env** (set per-teammate in the `pidgeot` server's `env` block, never hard-coded):
  - `COS_API_URL` — the deployed API base URL (operator-provided; see `reference/mcp-setup.md`)
  - `COS_API_TOKEN` — a per-user token minted from the dashboard's "MCP tokens" view (Settings →
    MCP Tokens → "New token" → copy the value shown once)
- **Per-user scoping:** every tool call is scoped to whichever user's token is configured — there
  is no `userId` parameter anywhere in this tool surface. To act as a different user, mint and
  swap in a different token.

## MCP gate (mandatory)

Before any data call:

1. Confirm MCP server **`pidgeot`** is connected (MCP panel shows its six tools).
2. If tools are missing or a call fails with an auth/connection error, **STOP** and point to
   [`reference/mcp-setup.md`](./reference/mcp-setup.md) (reload Cursor, confirm `COS_API_URL`/
   `COS_API_TOKEN`, re-mint a token if it was revoked/expired). Do not bypass with a raw `curl`
   against the API.

## Tool catalog

| Tool | Kind | Purpose |
|---|---|---|
| `retrieveContext` | read | RAG-grounded search over one account's communication + Asana knowledge layer |
| `recommendAction` | read | The agent's already-computed recommended action for a `commId` |
| `draftReply` | read | The agent's already-drafted, style-matched reply for a `commId` |
| `approveDraft` | **write, confirm-gated** | Sends the drafted reply through the real connected channel |
| `supplyContext` | write, non-destructive | Appends clarifying text and re-queues a `needs_context` communication |
| `manageAsana` | **write, confirm-gated** | Creates a new Asana follow-up task, or links an existing one |

## Confirm-gate protocol (non-negotiable)

`approveDraft` and `manageAsana` accept a `confirm` boolean (default `false`). When `confirm` is
not explicitly `true`, the MCP server tool handler returns a **preview only** and performs no
network call to the hosted API at all — nothing is sent, nothing is written to Asana. Always:

1. Call the tool with `confirm` omitted (or `false`) first, or use the read-only tool
   (`draftReply`) to get the exact content.
2. Show the user the EXACT draft body (for `approveDraft`) or the exact task title/notes/due date
   or target task (for `manageAsana`).
3. Only re-invoke with `confirm: true` after the user gives an explicit, unambiguous "yes, send
   it" / "yes, create/link it". Never infer confirmation from tone, urgency, or a general "looks
   good" about something else.

## Exploration playbook

1. **Prior context on a topic/person/thread** — `retrieveContext` with `accountId` + a
   natural-language `query`; optional `topK` (default 5, max 10).
2. **What should happen with a communication** — `recommendAction` with `commId`. Returns
   `{ actionType, confidence, rationale }` or `null` if the agent hasn't classified it yet.
3. **What the reply would say** — `draftReply` with `commId`. Returns `{ body, confidence }` or
   `null` if no draft exists yet (e.g. still `needs_context`).
4. **Send it** — `approveDraft` with `commId`, `confirm: true` only after step-by-step approval
   above. Returns `{ status: 'sent', sentMessageId }` on success.
5. **Agent needs more info** — `supplyContext` with `commId` + `text` (the user's clarification).
   Safe to call directly; re-queues the communication for another agent pass.
6. **Log Asana follow-up** — `manageAsana` with `action: 'create'` (+ `title`, optional
   `notes`/`dueOn`) or `action: 'link'` (+ `taskGid`), `confirm: true` only after approval.

## Non-negotiables

- **MCP tools only** for Chief of Staff data reads/writes in this workflow.
- Never hard-code or print `COS_API_TOKEN` or any other credential.
- Never call `approveDraft`/`manageAsana` with `confirm: true` without the user's explicit,
  content-specific approval in the current turn.
- A 401/`UNAUTHORIZED` response means the token is missing, unknown, or revoked — re-mint from the
  dashboard; never retry with a guessed or previously-seen token belonging to someone else.
- Report methodology: tools called, in order, with the ids/params used.

## Expected output

When answering, return:

- Restated task and the `commId`/`accountId` involved
- MCP tools called (in order) and key parameters
- The result: context hits, recommendation, draft body, send confirmation, or Asana link
- Whether anything was actually written (`sent`/`done`) vs. only previewed
- Gaps or blockers with the exact fix (token expired, MCP not connected, etc.)

## Related agents in this kit

| Task | Use |
|------|-----|
| Operate the Chief of Staff agent via MCP (this skill) | `pidgeot` agent |

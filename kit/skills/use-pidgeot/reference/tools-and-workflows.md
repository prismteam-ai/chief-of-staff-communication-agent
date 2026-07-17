# Pidgeot MCP — tool catalog and workflows

All six tools live on MCP server **`pidgeot`**. Every call is scoped server-side to the userId the
configured `COS_API_TOKEN` was issued for — none of these tools accept or need a `userId`
parameter.

## `retrieveContext` (read)

RAG-grounded search over one account's communication + Asana knowledge layer.

- **Input:** `accountId` (required — must be an account the token's user owns), `query` (required,
  natural language), `topK` (optional, 1-10, default 5)
- **Output:** `{ hits: [{ chunkId, sourceId, textForContext, score, channel, sourceType }] }`
- **When:** the user asks "what do we know about X", "find prior conversation about Y", or before
  drafting/recommending anything from scratch that would benefit from prior context.

## `recommendAction` (read)

The agent's already-computed recommended action for one communication — NOT a fresh
classification (the ingest pipeline classifies every communication automatically as it arrives).

- **Input:** `commId` (required)
- **Output:** `{ commId, status, recommendation: { actionType, confidence, rationale } | null }`
  — `null` when the communication hasn't reached a `recommended`+ state yet.
- **`actionType`** is one of: `reply_needed`, `fyi_no_reply`, `schedule`, `delegate`, `escalate`,
  `needs_context`.

## `draftReply` (read)

The agent's already-drafted, style-matched reply for one communication.

- **Input:** `commId` (required)
- **Output:** `{ commId, status, draft: { body, confidence } | null }` — `null` when no draft
  exists yet (e.g. the communication is still `needs_context` or below the confidence threshold).
- Always show the FULL `body` to the user verbatim before ever calling `approveDraft`.

## `approveDraft` (write, confirm-gated)

Approves and **sends** the drafted reply through the real connected channel (Gmail/WhatsApp).

- **Input:** `commId` (required), `confirm` (boolean, default `false`)
- **Output when `confirm` is not `true`:** `{ status: "preview", commId, message }` — nothing is
  sent, no network call reaches the hosted API at all.
- **Output when `confirm: true`:** `{ status: "sent", commId, sentMessageId }` — the real send has
  happened. This is irreversible from this tool's perspective (the email/message is gone).
- **Protocol:** call `draftReply` first (or use a preview call), show the user the exact body, get
  an explicit "yes, send it", THEN call again with `confirm: true`.

## `supplyContext` (write, non-destructive)

Appends clarifying text to a `needs_context` communication and re-queues it for another agent
pass. Not confirm-gated — this never sends anything or mutates Asana, so it is safe to call as
soon as the user has actually provided the missing information.

- **Input:** `commId` (required, must currently be `needs_context`), `text` (required, the user's
  clarification in their own words)
- **Output:** `{ commId, status }` — `status` becomes `awaiting_reprocess`.

## `manageAsana` (write, confirm-gated)

Creates a new Asana follow-up task, or links a communication to an existing one.

- **Input:** `action` (`"create"` | `"link"`, required), `commId` (required), plus:
  - `action: "create"` → `title` (required), `notes` (optional), `dueOn` (optional, `YYYY-MM-DD`)
  - `action: "link"` → `taskGid` (required, an existing Asana task gid)
  - `confirm` (boolean, default `false`)
- **Output when `confirm` is not `true`:** `{ status: "preview", commId, message }` — nothing is
  written to Asana.
- **Output when `confirm: true`:** `{ status: "done", commId, asanaTaskGid, asanaTaskPermalink }`.
- **Protocol:** show the user the exact title/notes/due date (create) or target task (link) before
  ever calling with `confirm: true`.

## Decision tree

```
User asks about a communication or topic
├─ "What do we know about X?" ──────────────► retrieveContext
├─ "What should happen with this?" ─────────► recommendAction
├─ "What would the reply say?" ─────────────► draftReply
├─ "Send it" / "Approve it" ─────────────────► draftReply (show body) → confirm → approveDraft(confirm: true)
├─ "I need to add more info" ────────────────► supplyContext
└─ "Log this in Asana" / "Link this task" ──► manageAsana (show preview) → confirm → manageAsana(confirm: true)
```

## Error handling

- **`401 UNAUTHORIZED`** (any tool): the bearer token is missing, unknown, or revoked. Point the
  user to `reference/mcp-setup.md`'s token-minting steps. Never retry with a different/guessed
  token — that would be probing for another user's access.
- **`PRECONDITION_FAILED`** (`retrieveContext` only): the RAG domain isn't wired for this deploy.
  Report this as a deployment gap, not a user error.
- **Illegal-state errors** (e.g. `approveDraft` on a communication with no draft, `supplyContext`
  on one not in `needs_context`): report the current `status` from the read tools and explain
  which state transition is actually legal next.

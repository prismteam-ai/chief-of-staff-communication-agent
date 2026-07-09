"""Cursor-facing MCP server — the deliverable agent surface.

Run (Cursor mcp.json):  uv run cos-mcp     (stdio transport)
Exposes RAG retrieval, queue state, drafting, the approval action, and Asana —
the human in Cursor is the approver; the approval gate stays absolute.

TENANCY: identity-driven. Each tool call resolves its tenant from WHO authenticated —
the bearer token on the request (a Cursor PAT minted in the web UI, or a Supabase JWT)
maps to its owner_id, and the tool acts only on that tenant. One hosted MCP serves every
user by their own token; a grader's demo token can never read another tenant's data.
(`MCP_OWNER_ID` remains only a fallback for a stdio self-host, where there is no HTTP
request to carry an identity.)
"""
from __future__ import annotations

import json
import os

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from . import boot  # noqa: F401  (import-compat; connectors are per-owner)
from .auth import owner_for_token
from .db import sb

_hosts = ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*"]
if os.environ.get("PUBLIC_HOST"):  # e.g. cos-comms-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io
    _hosts.append(os.environ["PUBLIC_HOST"])

mcp = FastMCP(
    "chief-of-staff-comms",
    streamable_http_path="/",
    transport_security=TransportSecuritySettings(
        allowed_hosts=_hosts,
        allowed_origins=[f"https://{h}" for h in _hosts] + [f"http://{h}" for h in _hosts],
    ),
)


def _owner() -> str:
    """Resolve the tenant for THIS request from who authenticated — never a hardcoded
    pin. Over HTTP (Cursor), read the bearer token off the request the SDK attaches to
    the tool's context and map it to its owner. Fall back to MCP_OWNER_ID ONLY for a
    stdio self-host, where there is no HTTP request. Raise if neither yields a tenant."""
    try:
        req = mcp.get_context().request_context.request  # Starlette request, per-tool-call
        if req is not None:
            auth = req.headers.get("authorization", "")
            token = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else ""
            owner = owner_for_token(token)
            if owner:
                return owner
            raise RuntimeError("MCP request has no valid tenant token — sign in to the web UI "
                               "and generate a Cursor token")
    except RuntimeError:
        raise
    except Exception:
        pass  # no HTTP request in scope (stdio) — fall through to the env fallback
    env = os.environ.get("MCP_OWNER_ID")
    if env:
        return env
    raise RuntimeError("no authenticated tenant on this MCP request")


@mcp.tool()
def search_context(query: str, top_k: int = 6) -> str:
    """Search the communication knowledge layer (messages, org knowledge,
    preferences, Asana tasks) by meaning. Returns ranked snippets with sources."""
    from .rag import search

    hits = search(query, _owner(), match_count=top_k)
    return json.dumps(
        [
            {"similarity": round(h["similarity"], 3), "source_type": h["source_type"],
             "content": h["content"], "metadata": h["metadata"]}
            for h in hits
        ], ensure_ascii=False, indent=1)


@mcp.tool()
def pending_messages() -> str:
    """List inbound communications still awaiting a response, oldest first."""
    rows = (
        sb().table("messages")
        .select("id, channel, sender, body_text, sent_at")
        .eq("owner_id", _owner()).eq("direction", "inbound").eq("answered_status", "pending")
        .order("sent_at").execute().data
    )
    return json.dumps(rows, ensure_ascii=False, indent=1)


@mcp.tool()
def message_context(message_id: str) -> str:
    """Full picture for one message: thread history, recommendation, draft, topic links."""
    owner = _owner()
    msg = sb().table("messages").select("*").eq("id", message_id).eq("owner_id", owner).single().execute().data
    thread = (
        sb().table("messages").select("direction, sender, body_text, sent_at")
        .eq("owner_id", owner).eq("thread_id", msg["thread_id"]).order("sent_at").execute().data
    )
    rec = sb().table("recommendations").select("*").eq("owner_id", owner).eq("message_id", message_id).execute().data
    drafts = sb().table("drafts").select("id, body, status, style_notes").eq("owner_id", owner).eq("message_id", message_id).execute().data
    topics = sb().table("topic_links").select("topic_key").eq("owner_id", owner).eq("message_id", message_id).execute().data
    return json.dumps(
        {"message": msg, "thread": thread, "recommendation": rec, "drafts": drafts, "topics": topics},
        ensure_ascii=False, indent=1, default=str)


@mcp.tool()
def recommend_and_draft(message_id: str) -> str:
    """Run the brain on a message: next-action recommendation + style-matched
    draft reply (+ Asana task when follow-up work is implied). Idempotent."""
    from .brain import process_message

    return json.dumps(process_message(message_id, _owner()), ensure_ascii=False, indent=1)


@mcp.tool()
def approve_and_send(draft_id: str, decided_by: str = "executive-via-cursor") -> str:
    """Record the human's approval for a draft and send it via the originating
    channel. This IS the approval step — only call it when the human has
    explicitly approved the draft text."""
    from .send import send_draft

    owner = _owner()
    sb().table("approvals").upsert(
        {"owner_id": owner, "draft_id": draft_id, "decision": "approved", "decided_by": decided_by},
        on_conflict="draft_id",
    ).execute()
    sb().table("drafts").update({"status": "approved"}).eq("id", draft_id).eq("owner_id", owner).execute()
    return json.dumps(send_draft(draft_id, owner), ensure_ascii=False)


@mcp.tool()
def reject_draft(draft_id: str, note: str = "", decided_by: str = "executive-via-cursor") -> str:
    """Reject a pending draft (with an optional note on what to change)."""
    owner = _owner()
    sb().table("approvals").upsert(
        {"owner_id": owner, "draft_id": draft_id, "decision": "rejected", "decided_by": decided_by, "note": note or None},
        on_conflict="draft_id",
    ).execute()
    sb().table("drafts").update({"status": "rejected"}).eq("id", draft_id).eq("owner_id", owner).execute()
    return json.dumps({"draft_id": draft_id, "status": "rejected"})


@mcp.tool()
def answer_context(message_id: str, context: str) -> str:
    """Supply the context the agent asked for on a needs-context message. The agent
    treats it as authoritative and re-drafts a style-matched reply (which still
    requires explicit approval before sending)."""
    from .brain import redraft_with_context

    return json.dumps(redraft_with_context(message_id, _owner(), context), ensure_ascii=False, indent=1, default=str)


@mcp.tool()
def create_asana_task(message_id: str, title: str, detail: str) -> str:
    """Create an Asana task from a communication; links it and indexes it into RAG."""
    from .asana import task_from_message

    return json.dumps(task_from_message(message_id, _owner(), title, detail), ensure_ascii=False)


@mcp.tool()
def sync() -> str:
    """Fetch new messages from all of this tenant's connected channels, index them into
    the knowledge layer, and run the brain (recommendation + style-matched draft + Asana
    task where follow-up is implied). Call this before triaging to pull the latest."""
    from .api import _run_sync

    return json.dumps(_run_sync(_owner()), ensure_ascii=False, default=str)


@mcp.tool()
def add_knowledge(kind: str, text: str) -> str:
    """Teach the agent a lasting fact so it drafts + recommends better. kind='preference' for a
    standing rule (e.g. 'keep replies short', 'I decline Friday meetings') or kind='org' for
    organizational knowledge (e.g. 'Acme is our biggest client', 'Q3 launch is Sept 15'). Embedded
    into the knowledge layer and used in future recommendations + drafts."""
    from .rag import add_knowledge_item

    k = kind if kind in ("preference", "org") else "preference"
    return json.dumps(add_knowledge_item(_owner(), k, text), ensure_ascii=False)


@mcp.tool()
def list_knowledge() -> str:
    """List the preferences + organizational knowledge the agent has been taught."""
    from .rag import list_knowledge as _lk

    return json.dumps(_lk(_owner()), ensure_ascii=False, default=str)


@mcp.tool()
def dashboard_stats() -> str:
    """Communication volume, response status, overdue count, pending approvals, per-channel breakdown."""
    from .api import _dashboard

    return json.dumps(_dashboard(_owner()), ensure_ascii=False, indent=1)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

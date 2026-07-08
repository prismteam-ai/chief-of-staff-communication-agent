"""Cursor-facing MCP server — the deliverable agent surface.

Run (Cursor mcp.json):  uv run cos-mcp     (stdio transport)
Exposes RAG retrieval, queue state, drafting, the approval action, and Asana —
the human in Cursor is the approver; the approval gate stays absolute.
"""
from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from . import boot  # noqa: F401  (registers connectors)
from .db import sb

mcp = FastMCP("chief-of-staff-comms")


@mcp.tool()
def search_context(query: str, top_k: int = 6) -> str:
    """Search the communication knowledge layer (messages, org knowledge,
    preferences, Asana tasks) by meaning. Returns ranked snippets with sources."""
    from .rag import search

    hits = search(query, match_count=top_k)
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
        .eq("direction", "inbound").eq("answered_status", "pending")
        .order("sent_at").execute().data
    )
    return json.dumps(rows, ensure_ascii=False, indent=1)


@mcp.tool()
def message_context(message_id: str) -> str:
    """Full picture for one message: thread history, recommendation, draft, topic links."""
    msg = sb().table("messages").select("*").eq("id", message_id).single().execute().data
    thread = (
        sb().table("messages").select("direction, sender, body_text, sent_at")
        .eq("thread_id", msg["thread_id"]).order("sent_at").execute().data
    )
    rec = sb().table("recommendations").select("*").eq("message_id", message_id).execute().data
    drafts = sb().table("drafts").select("id, body, status, style_notes").eq("message_id", message_id).execute().data
    topics = sb().table("topic_links").select("topic_key").eq("message_id", message_id).execute().data
    return json.dumps(
        {"message": msg, "thread": thread, "recommendation": rec, "drafts": drafts, "topics": topics},
        ensure_ascii=False, indent=1, default=str)


@mcp.tool()
def recommend_and_draft(message_id: str) -> str:
    """Run the brain on a message: next-action recommendation + style-matched
    draft reply (+ Asana task when follow-up work is implied). Idempotent."""
    from .brain import process_message

    return json.dumps(process_message(message_id), ensure_ascii=False, indent=1)


@mcp.tool()
def approve_and_send(draft_id: str, decided_by: str = "executive-via-cursor") -> str:
    """Record the human's approval for a draft and send it via the originating
    channel. This IS the approval step — only call it when the human has
    explicitly approved the draft text."""
    from .send import send_draft

    sb().table("approvals").insert(
        {"draft_id": draft_id, "decision": "approved", "decided_by": decided_by}
    ).execute()
    sb().table("drafts").update({"status": "approved"}).eq("id", draft_id).execute()
    return json.dumps(send_draft(draft_id), ensure_ascii=False)


@mcp.tool()
def reject_draft(draft_id: str, note: str = "", decided_by: str = "executive-via-cursor") -> str:
    """Reject a pending draft (with an optional note on what to change)."""
    sb().table("approvals").insert(
        {"draft_id": draft_id, "decision": "rejected", "decided_by": decided_by, "note": note or None}
    ).execute()
    sb().table("drafts").update({"status": "rejected"}).eq("id", draft_id).execute()
    return json.dumps({"draft_id": draft_id, "status": "rejected"})


@mcp.tool()
def create_asana_task(message_id: str, title: str, detail: str) -> str:
    """Create an Asana task from a communication; links it and indexes it into RAG."""
    from .asana import task_from_message

    return json.dumps(task_from_message(message_id, title, detail), ensure_ascii=False)


@mcp.tool()
def dashboard_stats() -> str:
    """Communication volume, response status, overdue count, pending approvals, per-channel breakdown."""
    from .api import dashboard

    return json.dumps(dashboard(), ensure_ascii=False, indent=1)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

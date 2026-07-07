"""FastAPI surface: dashboard metrics, queues, and the approval flow."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import boot  # registers connectors
from .brain import process_pending
from .db import sb
from .ingest import ingest_all
from .rag import index_messages, search
from .send import ApprovalRequired, send_draft

app = FastAPI(title="Chief of Staff Communication Agent")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat()}


@app.post("/api/sync")
def sync() -> dict:
    """Ingest all channels, index new content, process new inbound messages."""
    report = ingest_all()
    rag = index_messages()
    brain = process_pending()
    return {"ingest": report, "rag": rag, "brain": brain}


@app.get("/api/dashboard")
def dashboard() -> dict:
    msgs = sb().table("messages").select("id, channel, direction, answered_status, sent_at, answered_at").execute().data
    inbound = [m for m in msgs if m["direction"] == "inbound"]
    answered = [m for m in inbound if m["answered_status"] == "answered"]
    pending = [m for m in inbound if m["answered_status"] == "pending"]
    now = datetime.now(timezone.utc)
    overdue = [
        m for m in pending
        if (now - datetime.fromisoformat(m["sent_at"].replace("Z", "+00:00"))).total_seconds() > 300
    ]
    response_times = []
    for m in answered:
        if m["answered_at"]:
            dt = datetime.fromisoformat(m["answered_at"].replace("Z", "+00:00")) - datetime.fromisoformat(
                m["sent_at"].replace("Z", "+00:00")
            )
            response_times.append(dt.total_seconds())
    drafts_pending = sb().table("drafts").select("id").eq("status", "pending").execute().data
    by_channel: dict = {}
    for m in inbound:
        by_channel.setdefault(m["channel"], {"total": 0, "pending": 0})
        by_channel[m["channel"]]["total"] += 1
        if m["answered_status"] == "pending":
            by_channel[m["channel"]]["pending"] += 1
    return {
        "volume": {"inbound": len(inbound), "total": len(msgs)},
        "response_status": {"answered": len(answered), "pending": len(pending)},
        "overdue_over_5min": len(overdue),
        "pending_approvals": len(drafts_pending),
        "channel_breakdown": by_channel,
        "response_time_seconds": {
            "median": sorted(response_times)[len(response_times) // 2] if response_times else None,
            "count": len(response_times),
        },
    }


@app.get("/api/messages")
def messages(status: str | None = None) -> list[dict]:
    q = sb().table("messages").select(
        "id, channel, direction, sender, body_text, sent_at, answered_status, source_id, raw_ref"
    ).eq("direction", "inbound").order("sent_at", desc=True)
    if status:
        q = q.eq("answered_status", status)
    return q.execute().data


@app.get("/api/recommendations")
def recommendations() -> list[dict]:
    return (
        sb().table("recommendations")
        .select("id, message_id, action, rationale, needs_context, context_question, model, created_at")
        .order("created_at", desc=True).execute().data
    )


@app.get("/api/drafts")
def drafts(status: str = "pending") -> list[dict]:
    return (
        sb().table("drafts").select("id, message_id, body, style_notes, status, created_at")
        .eq("status", status).order("created_at").execute().data
    )


class Decision(BaseModel):
    decision: str  # approved | rejected
    decided_by: str = "executive"
    note: str | None = None


@app.post("/api/drafts/{draft_id}/decide")
def decide(draft_id: str, d: Decision) -> dict:
    if d.decision not in ("approved", "rejected"):
        raise HTTPException(422, "decision must be approved|rejected")
    sb().table("approvals").insert(
        {"draft_id": draft_id, "decision": d.decision, "decided_by": d.decided_by, "note": d.note}
    ).execute()
    new_status = "approved" if d.decision == "approved" else "rejected"
    sb().table("drafts").update({"status": new_status}).eq("id", draft_id).execute()
    result: dict = {"draft_id": draft_id, "decision": d.decision}
    if d.decision == "approved":
        try:
            result["send"] = send_draft(draft_id)
        except ApprovalRequired as e:  # defense in depth; should be unreachable
            raise HTTPException(409, str(e))
    return result


@app.get("/api/search")
def rag_search_endpoint(q: str) -> list[dict]:
    return search(q)


@app.get("/api/topics/{topic_key}")
def topic(topic_key: str) -> list[dict]:
    links = sb().table("topic_links").select("message_id, reason, confidence").eq("topic_key", topic_key).execute().data
    ids = [l["message_id"] for l in links]
    if not ids:
        return []
    return (
        sb().table("messages").select("id, channel, sender, body_text, sent_at")
        .in_("id", ids).order("sent_at").execute().data
    )

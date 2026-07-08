"""FastAPI surface: dashboard metrics, queues, approval flow, MCP over HTTP.

Every /api route except /api/health and /api/login requires a Supabase JWT
(see auth.py) — the runtime is public, and an unauthenticated caller must not
be able to read comms or approve sends.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import boot  # noqa: F401  (side effect: registers channel connectors)
from .auth import login as auth_login
from .auth import require_user
from .brain import process_pending
from .db import sb
from .ingest import ingest_all
from .mcp_server import mcp as mcp_app_server
from .rag import index_messages, search
from .send import ApprovalRequired, send_draft

log = logging.getLogger(__name__)


async def _autosync_loop() -> None:
    interval = int(os.environ.get("AUTOSYNC_INTERVAL_S", "300"))
    while True:
        try:
            await asyncio.to_thread(_run_sync)
        except Exception:
            log.exception("autosync cycle failed; next attempt in %ss", interval)
        await asyncio.sleep(interval)


def _run_sync() -> dict:
    report = ingest_all()
    rag = index_messages()
    brain = process_pending()
    log.info("sync: %s new msgs, %s indexed, %s brained",
             sum(c.get("new", 0) for c in report["channels"].values()), rag.get("indexed"), len(brain))
    return {"ingest": report, "rag": rag, "brain": brain}


@asynccontextmanager
async def _lifespan(app: FastAPI):
    task = None
    if os.environ.get("AUTOSYNC", "0") == "1":
        task = asyncio.create_task(_autosync_loop())
    async with mcp_app_server.session_manager.run():
        yield
    if task:
        task.cancel()


app = FastAPI(title="Chief of Staff Communication Agent", lifespan=_lifespan)

public = APIRouter(prefix="/api")
api = APIRouter(prefix="/api", dependencies=[Depends(require_user)])


@public.get("/health")
def health() -> dict:
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat()}


class LoginBody(BaseModel):
    email: str
    password: str


@public.post("/login")
def login(body: LoginBody) -> dict:
    return auth_login(body.email, body.password)


@api.post("/sync")
def sync() -> dict:
    """Ingest all channels, index new content, process new inbound messages."""
    return _run_sync()


@api.get("/dashboard")
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


@api.get("/messages")
def messages(status: str | None = None) -> list[dict]:
    q = sb().table("messages").select(
        "id, channel, direction, sender, body_text, sent_at, answered_status, source_id, raw_ref"
    ).eq("direction", "inbound").order("sent_at", desc=True)
    if status:
        q = q.eq("answered_status", status)
    return q.execute().data


@api.get("/recommendations")
def recommendations() -> list[dict]:
    return (
        sb().table("recommendations")
        .select("id, message_id, action, rationale, needs_context, context_question, model, created_at")
        .order("created_at", desc=True).execute().data
    )


@api.get("/drafts")
def drafts(status: str = "pending") -> list[dict]:
    return (
        sb().table("drafts").select("id, message_id, body, style_notes, status, created_at")
        .eq("status", status).order("created_at").execute().data
    )


class Decision(BaseModel):
    decision: str  # approved | rejected
    decided_by: str = "executive"
    note: str | None = None


@api.post("/drafts/{draft_id}/decide")
def decide(draft_id: str, d: Decision, user: str = Depends(require_user)) -> dict:
    if d.decision not in ("approved", "rejected"):
        raise HTTPException(422, "decision must be approved|rejected")
    current = sb().table("drafts").select("status").eq("id", draft_id).execute().data
    if not current:
        raise HTTPException(404, "draft not found")
    if current[0]["status"] == "sent":
        raise HTTPException(409, "draft already sent — decisions are final after send")
    # upsert: a rejected draft may later be approved (and vice versa) without a 500
    sb().table("approvals").upsert(
        {"draft_id": draft_id, "decision": d.decision, "decided_by": d.decided_by or user, "note": d.note},
        on_conflict="draft_id",
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


@api.get("/search")
def rag_search_endpoint(q: str) -> list[dict]:
    return search(q)


@api.get("/topics/{topic_key}")
def topic(topic_key: str) -> list[dict]:
    links = sb().table("topic_links").select("message_id, reason, confidence").eq("topic_key", topic_key).execute().data
    ids = [link["message_id"] for link in links]
    if not ids:
        return []
    return (
        sb().table("messages").select("id, channel, sender, body_text, sent_at")
        .in_("id", ids).order("sent_at").execute().data
    )


app.include_router(public)
app.include_router(api)


class _MCPAuth:
    """The MCP surface exposes send/Asana-write tools — it gets the same gate as
    the REST API. Accepts a Supabase JWT or the static MCP_AUTH_TOKEN (simpler
    to configure in Cursor's headers)."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
            auth = headers.get("authorization", "")
            token = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else ""
            static = os.environ.get("MCP_AUTH_TOKEN", "")
            ok = bool(static) and token == static
            if not ok and token:
                try:
                    await asyncio.to_thread(sb().auth.get_user, token)
                    ok = True
                except Exception:
                    ok = False
            if not ok:
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body",
                            "body": b'{"error":"unauthorized: bearer token required for /mcp"}'})
                return
        await self.inner(scope, receive, send)


# Cursor agent over streamable HTTP at /mcp (same public host — no localhost)
app.mount("/mcp", _MCPAuth(mcp_app_server.streamable_http_app()))

# dashboard UI (static, same origin). Mounted last so /api/* and /mcp win.
_web = Path(__file__).resolve().parents[2] / "web"
if _web.exists():
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")

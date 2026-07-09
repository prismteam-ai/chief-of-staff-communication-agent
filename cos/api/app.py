"""FastAPI app for the Chief of Staff frontend.

Run:  ``uvicorn cos.api.app:app --port 8000``  (needs the provider mock on :8900, or
MODE=real creds). Reuses the existing engine unchanged; see cos/api/__init__.py.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from cos.agents import brain
from cos.api import connections
from cos.api.auth import current_user, require_owner
from cos.api.schemas import (
    ApproveRequest,
    ConnectionUpdate,
    StreamRequest,
    StyleUpdate,
    to_jsonable,
)
from cos.config import get_settings
from cos.kb.build import build_kb
from cos.kb.ontology import AsanaOp, Recommendation
from cos.models import Channel, Direction, Message, Participant

app = FastAPI(title="Chief of Staff — app API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- KB cache (lazy, rebuildable after a connections change) -----------------
_KB = None


def kb():
    global _KB
    if _KB is None:
        _KB = build_kb()
    return _KB


def rebuild_kb() -> None:
    global _KB
    _KB = None


# ---- message helpers --------------------------------------------------------
def _custom_message(sender: str, channel: str, body: str) -> Message:
    sender = (sender or "").strip()
    is_email = "@" in sender and "." in sender.split("@")[-1]
    p = Participant(id=f"in:{sender}", name=sender or "unknown",
                    email=sender if is_email else None,
                    handle=None if is_email else sender)
    return Message(id="ui:custom", channel=Channel(channel), thread_id="ui:custom",
                   sender=p, timestamp=datetime.now(timezone.utc),
                   body=body or "", direction=Direction.incoming)


def _resolve_message(req: StreamRequest) -> Message:
    if req.message_id:
        for m in kb().messages:
            if m.id == req.message_id:
                return m
        raise HTTPException(status_code=404, detail=f"unknown message {req.message_id}")
    if not (req.channel and req.body):
        raise HTTPException(status_code=422, detail="need message_id or channel+body")
    return _custom_message(req.sender or "unknown", req.channel, req.body)


def _awaiting_thread_ids() -> set[str]:
    return {th[0].thread_id for th in kb().graph.awaiting_threads() if th}


def _overdue_thread_ids() -> set[str]:
    return {th[0].thread_id for th in kb().graph.stale_outbound() if th}


# ---- routes -----------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    from cos.agents.llm import has_key
    s = get_settings()
    return {"ok": True, "mode": s.mode, "has_openai_key": has_key()}


@app.get("/api/messages")
def messages(user: dict = Depends(current_user)) -> dict:
    awaiting, overdue = _awaiting_thread_ids(), _overdue_thread_ids()
    out = []
    for m in kb().messages:
        out.append({
            "id": m.id, "channel": m.channel.value, "thread_id": m.thread_id,
            "sender": {"name": m.sender.name, "handle": m.sender.handle,
                       "email": m.sender.email},
            "subject": m.subject, "snippet": m.body[:140],
            "timestamp": m.timestamp.isoformat(),
            "awaiting": m.thread_id in awaiting,
            "overdue": m.thread_id in overdue,
        })
    return {"messages": out, "count": len(out)}


@app.get("/api/messages/{message_id}/context")
def message_context(message_id: str, user: dict = Depends(current_user)) -> dict:
    m = _resolve_message(StreamRequest(message_id=message_id))
    pack = kb().retriever.context_pack(m)
    return to_jsonable(pack)


@app.post("/api/agent/stream")
def agent_stream(req: StreamRequest, user: dict = Depends(current_user)):
    m = _resolve_message(req)

    def gen():
        try:
            for event in brain.stream(m, dry_run=True):
                yield f"data: {json.dumps(to_jsonable(event))}\n\n"
        except Exception as e:  # noqa: BLE001 — surface to the UI, don't 500 mid-stream
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.post("/api/approve")
def approve(req: ApproveRequest, user: dict = Depends(require_owner)) -> dict:
    """Owner-only. The only path that really sends — the approval gate."""
    from cos.connectors import all_connectors

    conn = {c.name: c for c in all_connectors()}.get(req.channel)
    if conn is None:
        raise HTTPException(status_code=400, detail=f"no connector for {req.channel}")
    sent = conn.send_reply(req.thread_id or "", req.text, to=req.to)

    known = next((m for m in kb().messages if m.id == req.message_id), None)

    asana_result = None
    if known is not None and req.asana_op and req.asana_op != AsanaOp.NONE.value:
        pack = kb().retriever.context_pack(known)
        rec = Recommendation(message_id=req.message_id, action="REPLY",
                             asana_op=AsanaOp(req.asana_op), rationale=req.text)
        asana_result = brain._execute_asana(rec, pack)

    response_seconds = None
    if known is not None:
        response_seconds = (datetime.now(timezone.utc) - known.timestamp).total_seconds()
    return {"sent": to_jsonable(sent), "asana": asana_result, "answered": True,
            "response_seconds": response_seconds}


@app.get("/api/style")
def get_style(user: dict = Depends(current_user)) -> dict:
    """The owner's editable style overrides + the learned profile they merge into."""
    from cos.agents import style
    from cos.agents.llm import has_key
    from cos.kb.style_store import load_overrides

    profile = None
    if has_key():
        try:
            profile = to_jsonable(style.owner_style_profile(kb()))
        except Exception:  # noqa: BLE001 — profile is a preview; overrides still editable
            profile = None
    return {"overrides": load_overrides(), "profile": profile,
            "editable": user.get("role") == "owner"}


@app.put("/api/style")
def put_style(update: StyleUpdate, user: dict = Depends(require_owner)) -> dict:
    """Owner-only. Persist the overrides and drop the learned-profile cache."""
    from cos.kb.style_store import load_overrides, save_overrides

    save_overrides(update.model_dump())
    return {"overrides": load_overrides(), "saved": True}


@app.get("/api/connections")
def get_connections(user: dict = Depends(current_user)) -> dict:
    return connections.all_status()


@app.post("/api/connections/{provider}")
def set_connection(provider: str, update: ConnectionUpdate,
                   user: dict = Depends(require_owner)) -> dict:
    try:
        status = connections.apply_update(provider, update.mode, update.credentials)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    rebuild_kb()   # connectors must rebuild against the new mode/creds
    return status

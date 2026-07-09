"""FastAPI surface: dashboard metrics, queues, approval flow, MCP over HTTP.

Every /api route except /api/health, /api/login and the OAuth callback requires a
Supabase JWT (see auth.py). CRITICAL: every data query is scoped to the caller's
owner_id (the tenant) — the runtime is multi-user and one tenant must never read
or act on another's comms. (Origin: 2026-07-09 audit — RLS was toothless and the
service_role backend returned the global dataset to any logged-in user.)
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import boot  # noqa: F401  (kept for import compatibility; connectors are per-owner now)
from .auth import User
from .auth import list_mcp_tokens, mint_mcp_token, owner_for_token, revoke_mcp_token
from .auth import login as auth_login
from .auth import require_user
from .brain import process_pending
from .db import sb
from .ingest import ingest_for_owner
from .mcp_server import mcp as mcp_app_server
from .rag import (
    add_knowledge_item,
    delete_knowledge_item,
    index_messages,
    list_knowledge,
    search,
    update_knowledge_item,
)
from .send import ApprovalRequired, send_draft

log = logging.getLogger(__name__)


def _owners_with_connectors() -> list[str]:
    rows = sb().table("connector_tokens").select("owner_id").execute().data
    return sorted({r["owner_id"] for r in rows if r.get("owner_id")})


def _run_sync(owner: str) -> dict:
    """Ingest → index → brain for ONE tenant."""
    report = ingest_for_owner(owner)
    rag = index_messages(owner)
    brain = process_pending(owner)
    log.info("sync[%s]: %s new msgs, %s indexed, %s brained", owner,
             sum(c.get("new", 0) for c in report["channels"].values()), rag.get("indexed"), len(brain))
    return {"ingest": report, "rag": rag, "brain": brain}


async def _autosync_loop() -> None:
    interval = int(os.environ.get("AUTOSYNC_INTERVAL_S", "300"))
    while True:
        try:
            for owner in await asyncio.to_thread(_owners_with_connectors):
                await asyncio.to_thread(_run_sync, owner)
        except Exception:
            log.exception("autosync cycle failed; next attempt in %ss", interval)
        await asyncio.sleep(interval)


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


# --- Google OAuth connect flow ------------------------------------------------
# The callback is public (browser redirect), so the tenant identity travels inside
# the signed state: a stateless HMAC over "timestamp:owner_id". That survives
# the host's idle spin-down between redirect-out and callback-back AND binds the
# grant to the tenant who started it — no forged callback can connect gmail into
# someone else's account.
def _oauth_secret() -> bytes:
    return (os.environ.get("MCP_AUTH_TOKEN") or os.environ["SUPABASE_SERVICE_ROLE_KEY"]).encode()


def _sign_state(owner: str) -> str:
    ts = str(int(time.time()))
    sig = hmac.new(_oauth_secret(), f"{ts}:{owner}".encode(), hashlib.sha256).hexdigest()[:20]
    return f"{ts}.{owner}.{sig}"


def _valid_state(state: str, max_age: int = 900) -> str | None:
    """Returns the owner_id if the state is authentic and fresh, else None."""
    try:
        ts, owner, sig = state.split(".", 2)
        expect = hmac.new(_oauth_secret(), f"{ts}:{owner}".encode(), hashlib.sha256).hexdigest()[:20]
        if hmac.compare_digest(sig, expect) and 0 <= time.time() - int(ts) <= max_age:
            return owner
    except Exception:
        pass
    return None


@api.get("/oauth/google/start")
def google_start(user: User = Depends(require_user)) -> dict:
    """Authed: mints the Google consent URL with the tenant bound into the state.
    The SPA fetches this (with its bearer token) then redirects the browser to url."""
    from .connectors.gmail_api import oauth_start_url

    return {"url": oauth_start_url(_sign_state(user.id))}


@public.get("/oauth/google/callback")
def google_callback(code: str, background: BackgroundTasks, state: str = ""):
    from fastapi.responses import RedirectResponse

    from .connectors.gmail_api import oauth_exchange

    owner = _valid_state(state)
    if not owner:
        raise HTTPException(400, "invalid or expired oauth state — restart from the Connections page")
    tokens = oauth_exchange(code)
    if not tokens.get("refresh_token"):
        raise HTTPException(502, "google returned no refresh token — remove the app's prior grant and retry")
    sb().table("connector_tokens").upsert(
        {"owner_id": owner, "channel": "gmail", "account_handle": tokens["email"],
         "refresh_token": tokens["refresh_token"], "scopes": "gmail.readonly gmail.send"},
        on_conflict="channel,account_handle",
    ).execute()
    log.info("gmail connected for %s (owner %s)", tokens["email"], owner)
    background.add_task(_run_sync, owner)  # first fetch starts immediately after connect
    return RedirectResponse("/?connected=gmail")


@api.post("/sync")
def sync(background: BackgroundTasks, user: User = Depends(require_user)) -> dict:
    """Kick off ingest → index → brain for the caller in the BACKGROUND — a full Gmail
    fetch can exceed the HTTP request timeout. Returns immediately; results land as they
    process (brain is newest-first, so fresh mail appears first), and autosync also runs
    on a schedule."""
    background.add_task(_run_sync, user.id)
    return {"status": "started"}


def _dashboard(owner: str) -> dict:
    """Dashboard metrics for one tenant. Shared by the HTTP endpoint and the MCP tool."""
    msgs = (
        sb().table("messages").select("id, channel, direction, answered_status, sent_at, answered_at")
        .eq("owner_id", owner).execute().data
    )
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
    drafts_pending = sb().table("drafts").select("id").eq("owner_id", owner).eq("status", "pending").execute().data
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
            "within_5min": sum(1 for s in response_times if s <= 300),
            "pct_within_5min": round(
                100 * sum(1 for s in response_times if s <= 300) / len(response_times)
            ) if response_times else None,
        },
    }


@api.get("/dashboard")
def dashboard(user: User = Depends(require_user)) -> dict:
    return _dashboard(user.id)


@api.get("/messages")
def messages(status: str | None = None, user: User = Depends(require_user)) -> list[dict]:
    q = sb().table("messages").select(
        "id, channel, direction, sender, body_text, sent_at, answered_status, source_id, raw_ref"
    ).eq("owner_id", user.id).eq("direction", "inbound").order("sent_at", desc=True)
    if status:
        q = q.eq("answered_status", status)
    return q.execute().data


@api.get("/recommendations")
def recommendations(user: User = Depends(require_user)) -> list[dict]:
    return (
        sb().table("recommendations")
        .select("id, message_id, action, rationale, needs_context, context_question, model, created_at")
        .eq("owner_id", user.id).order("created_at", desc=True).execute().data
    )


@api.get("/drafts")
def drafts(status: str = "pending", user: User = Depends(require_user)) -> list[dict]:
    q = (
        sb().table("drafts").select("id, message_id, body, style_notes, status, provider_message_id, created_at")
        .eq("owner_id", user.id)
    )
    if status != "all":  # "all" → every status (the Incoming board's Done column needs sent/rejected too)
        q = q.eq("status", status)
    return q.order("created_at").execute().data


class Decision(BaseModel):
    decision: str  # approved | rejected
    decided_by: str = "executive"
    note: str | None = None


@api.post("/drafts/{draft_id}/decide")
def decide(draft_id: str, d: Decision, user: User = Depends(require_user)) -> dict:
    if d.decision not in ("approved", "rejected"):
        raise HTTPException(422, "decision must be approved|rejected")
    current = sb().table("drafts").select("status").eq("id", draft_id).eq("owner_id", user.id).execute().data
    if not current:
        raise HTTPException(404, "draft not found")
    if current[0]["status"] == "sent":
        raise HTTPException(409, "draft already sent — decisions are final after send")
    # upsert: a rejected draft may later be approved (and vice versa) without a 500
    sb().table("approvals").upsert(
        {"owner_id": user.id, "draft_id": draft_id, "decision": d.decision,
         "decided_by": d.decided_by or user.email, "note": d.note},
        on_conflict="draft_id",
    ).execute()
    new_status = "approved" if d.decision == "approved" else "rejected"
    sb().table("drafts").update({"status": new_status}).eq("id", draft_id).eq("owner_id", user.id).execute()
    result: dict = {"draft_id": draft_id, "decision": d.decision}
    if d.decision == "approved":
        try:
            result["send"] = send_draft(draft_id, user.id)
        except ApprovalRequired as e:  # defense in depth; should be unreachable
            raise HTTPException(409, str(e))
    return result


@api.get("/asana")
def asana_links(user: User = Depends(require_user)) -> list[dict]:
    """This tenant's Asana tasks created from communications (message_id → task)."""
    return (
        sb().table("asana_links").select("message_id, task_url, task_gid, action, created_at")
        .eq("owner_id", user.id).order("created_at", desc=True).execute().data
    )


# --- Knowledge layer (user preferences + org knowledge → RAG) ----------------
class KnowledgeBody(BaseModel):
    kind: str   # preference | org
    text: str


@api.get("/knowledge")
def knowledge_list(user: User = Depends(require_user)) -> list[dict]:
    return list_knowledge(user.id)


@api.post("/knowledge")
def knowledge_add(k: KnowledgeBody, user: User = Depends(require_user)) -> dict:
    if k.kind not in ("preference", "org"):
        raise HTTPException(422, "kind must be preference|org")
    if not k.text.strip():
        raise HTTPException(422, "text is required")
    return add_knowledge_item(user.id, k.kind, k.text.strip())


@api.put("/knowledge/{source_id:path}")
def knowledge_edit(source_id: str, k: KnowledgeBody, user: User = Depends(require_user)) -> dict:
    if k.kind not in ("preference", "org"):
        raise HTTPException(422, "kind must be preference|org")
    if not k.text.strip():
        raise HTTPException(422, "text is required")
    return update_knowledge_item(user.id, source_id, k.kind, k.text.strip())


@api.delete("/knowledge/{source_id:path}")
def knowledge_delete(source_id: str, user: User = Depends(require_user)) -> dict:
    delete_knowledge_item(user.id, source_id)
    return {"deleted": source_id}


class McpTokenBody(BaseModel):
    label: str | None = None


@api.get("/mcp-tokens")
def mcp_tokens_list(user: User = Depends(require_user)) -> list[dict]:
    """This tenant's active Cursor tokens (masked — the raw value is shown only once, at mint)."""
    return list_mcp_tokens(user.id)


@api.post("/mcp-tokens")
def mcp_token_create(b: McpTokenBody = McpTokenBody(), user: User = Depends(require_user)) -> dict:
    """Mint a Cursor PAT bound to THIS signed-in tenant. The raw token is returned once."""
    return mint_mcp_token(user.id, (b.label or "").strip() or None)


@api.delete("/mcp-tokens/{token_id}")
def mcp_token_revoke(token_id: str, user: User = Depends(require_user)) -> dict:
    if not revoke_mcp_token(user.id, token_id):
        raise HTTPException(404, "token not found")
    return {"revoked": token_id}


@api.get("/search")
def rag_search_endpoint(q: str, user: User = Depends(require_user)) -> list[dict]:
    return search(q, user.id)


@api.get("/topics/{topic_key}")
def topic(topic_key: str, user: User = Depends(require_user)) -> list[dict]:
    links = (
        sb().table("topic_links").select("message_id, reason, confidence")
        .eq("owner_id", user.id).eq("topic_key", topic_key).execute().data
    )
    ids = [link["message_id"] for link in links]
    if not ids:
        return []
    return (
        sb().table("messages").select("id, channel, sender, body_text, sent_at")
        .eq("owner_id", user.id).in_("id", ids).order("sent_at").execute().data
    )


# --- Needs-context answer loop -----------------------------------------------
class ContextAnswer(BaseModel):
    context: str


@api.post("/messages/{message_id}/answer")
def answer_context(message_id: str, a: ContextAnswer, user: User = Depends(require_user)) -> dict:
    """Executive supplies the context the agent asked for → agent re-drafts a reply."""
    from .brain import redraft_with_context

    if not a.context.strip():
        raise HTTPException(422, "context is required")
    return redraft_with_context(message_id, user.id, a.context.strip())


# --- Connections (self-serve channel setup) ----------------------------------
# Real integrations only: gmail (OAuth), 2nd email (IMAP paste), telegram (MTProto).
# x/sms/whatsapp connectors exist but are credential-gated (not offered until funded).
# Real integrations, one per README channel. All bring-your-own-credentials and
# per-tenant. X/SMS/WhatsApp work on the user's OWN (paid) provider accounts — the
# platforms charge, but nothing stops a user connecting them. LinkedIn has no public
# personal-messaging API, so it is surfaced as unavailable rather than a dead button.
_CHANNEL_META = {
    "gmail": {"label": "Gmail", "method": "oauth"},
    "email": {"label": "Other email (IMAP)", "method": "paste"},
    "telegram": {"label": "Telegram (your account)", "method": "paste"},
    "x": {"label": "X · Twitter DMs", "method": "paste"},
    "sms": {"label": "SMS · Twilio", "method": "paste"},
    "whatsapp": {"label": "WhatsApp · Twilio", "method": "paste"},
    "linkedin": {"label": "LinkedIn", "method": "unavailable"},
}
# paste-connectable channels + the Asana integration
_CONNECTABLE = {"email", "telegram", "x", "sms", "whatsapp", "asana"}


@api.get("/connections")
def connections(user: User = Depends(require_user)) -> dict:
    tokens = (
        sb().table("connector_tokens").select("channel, account_handle, connected_at")
        .eq("owner_id", user.id).execute().data
    )
    by_channel: dict = {}
    for t in tokens:
        by_channel.setdefault(t["channel"], []).append(t)
    last_sync = {
        r["channel"]: r["fetched_at"]
        for r in sb().table("messages").select("channel, fetched_at").eq("owner_id", user.id)
        .order("fetched_at", desc=True).limit(200).execute().data
    }
    channels = []
    for ch, meta in _CHANNEL_META.items():
        accts = [t["account_handle"] for t in by_channel.get(ch, [])]
        channels.append({
            "channel": ch, "label": meta["label"], "method": meta["method"],
            "connected": bool(accts), "accounts": accts,
            "mode": "live" if accts else "not_connected",
            "last_sync": last_sync.get(ch),
        })
    from . import asana
    return {
        "channels": channels,
        "integrations": [{"name": "asana", "label": "Asana", "connected": asana.is_connected(user.id),
                          "method": "paste"}],
    }


class PasteCredential(BaseModel):
    account_handle: str
    secret: str
    scopes: str | None = None


@api.post("/channels/{channel}/connect")
def connect_channel(channel: str, c: PasteCredential, background: BackgroundTasks,
                    user: User = Depends(require_user)) -> dict:
    """Paste-key connect (IMAP/Telegram/Asana). Stores the credential for THIS tenant; the
    per-owner resolver (channels) or asana.client (Asana) picks it up. A message channel
    kicks off a first sync immediately."""
    if channel not in _CONNECTABLE:
        raise HTTPException(404, f"unknown channel {channel}")
    sb().table("connector_tokens").upsert(
        {"owner_id": user.id, "channel": channel, "account_handle": c.account_handle,
         "refresh_token": c.secret, "scopes": c.scopes},
        on_conflict="channel,account_handle",
    ).execute()
    log.info("channel %s connected via paste for %s (owner %s)", channel, c.account_handle, user.id)
    if channel != "asana":  # Asana is a task sink, not an ingest source
        background.add_task(_run_sync, user.id)
    return {"channel": channel, "account_handle": c.account_handle, "connected": True}


@api.delete("/channels/{channel}/connect")
def disconnect_channel(channel: str, user: User = Depends(require_user)) -> dict:
    """Remove THIS tenant's stored credential(s) for a channel so it can be re-connected
    (e.g. to swap an expired app-password or a bad token). Owner-scoped — only ever
    touches the caller's own tokens. Ingested history is left intact; only the connector
    credential is dropped, so syncing/sending stops until reconnected."""
    if channel not in _CONNECTABLE:
        raise HTTPException(404, f"unknown channel {channel}")
    res = (
        sb().table("connector_tokens").delete()
        .eq("owner_id", user.id).eq("channel", channel).execute()
    )
    log.info("channel %s disconnected for owner %s (%d token(s))", channel, user.id, len(res.data or []))
    return {"channel": channel, "disconnected": True, "removed": len(res.data or [])}


# --- People (cross-channel linking, made visible) ----------------------------
def _person_key(sender: dict) -> str:
    return (sender.get("display_name") or sender.get("handle") or "unknown").strip()


@api.get("/people")
def people(user: User = Depends(require_user)) -> list[dict]:
    rows = (
        sb().table("messages").select("sender, channel, direction, sent_at")
        .eq("owner_id", user.id).eq("direction", "inbound").execute().data
    )
    agg: dict = {}
    for m in rows:
        key = _person_key(m["sender"])
        p = agg.setdefault(key, {"name": key, "handles": set(), "channels": set(),
                                 "count": 0, "last_at": m["sent_at"]})
        if m["sender"].get("handle"):
            p["handles"].add(m["sender"]["handle"])
        p["channels"].add(m["channel"])
        p["count"] += 1
        if m["sent_at"] > p["last_at"]:
            p["last_at"] = m["sent_at"]
    out = [{**p, "handles": sorted(p["handles"]), "channels": sorted(p["channels"])}
           for p in agg.values()]
    out.sort(key=lambda p: (len(p["channels"]), p["last_at"]), reverse=True)
    return out


@api.get("/people/{name:path}")
def person(name: str, user: User = Depends(require_user)) -> dict:
    all_inbound = (
        sb().table("messages").select("id, channel, direction, sender, body_text, sent_at, answered_status")
        .eq("owner_id", user.id).eq("direction", "inbound").order("sent_at", desc=True).execute().data
    )
    msgs = [m for m in all_inbound if _person_key(m["sender"]) == name]
    ids = [m["id"] for m in msgs]
    topics, tasks = [], []
    if ids:
        topics = sb().table("topic_links").select("topic_key, message_id").eq("owner_id", user.id).in_("message_id", ids).execute().data
        tasks = sb().table("asana_links").select("task_url, task_gid, message_id").eq("owner_id", user.id).in_("message_id", ids).execute().data
    return {
        "name": name,
        "handles": sorted({m["sender"]["handle"] for m in msgs if m["sender"].get("handle")}),
        "channels": sorted({m["channel"] for m in msgs}),
        "messages": msgs,
        "topics": sorted({t["topic_key"] for t in topics}),
        "asana_tasks": tasks,
    }


app.include_router(public)
app.include_router(api)


class _MCPAuth:
    """Identity-driven gate for the MCP surface. The bearer token must resolve to an
    owner — a Cursor PAT (minted in the UI) or a Supabase session JWT. No valid token
    → 401 telling the caller to sign in and generate a token. The tenant a tool acts on
    is that same owner (mcp_server._owner reads the same header), so whoever signed in
    IS whose data Cursor sees — never a hardcoded pin. (Do NOT regress: no anonymous
    MCP access; no builder-controlled owner.)"""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
            auth = headers.get("authorization", "")
            token = auth.split(" ", 1)[1].strip() if auth.lower().startswith("bearer ") else ""
            owner = await asyncio.to_thread(owner_for_token, token) if token else None
            if not owner:
                body = (b'{"error":"unauthorized: sign in to the web UI and generate a '
                        b'Cursor token (Connections \\u2192 Connect Cursor), then put it in '
                        b'the Authorization header."}')
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.inner(scope, receive, send)


# Cursor agent over streamable HTTP at /mcp (same public host — no localhost)
app.mount("/mcp", _MCPAuth(mcp_app_server.streamable_http_app()))

# dashboard UI (static, same origin). Mounted last so /api/* and /mcp win.
_web = Path(__file__).resolve().parents[2] / "web"
if _web.exists():
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")

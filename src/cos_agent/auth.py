"""Auth gate: Supabase email/password JWTs on every mutating/reading API route.

The dashboard is public shell; every /api/* call (except health + login) needs
Authorization: Bearer <supabase access token>. Demo credentials are provisioned
by scripts/create_demo_user.py and shipped with the submission.
"""
from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request

from .db import sb, sb_auth

log = logging.getLogger(__name__)

MCP_TOKEN_PREFIX = "cosmcp_"  # Cursor personal access token, identity-bound to an owner


@dataclass(frozen=True)
class User:
    """The authenticated tenant. `id` is the Supabase auth user id == owner_id on
    every row; `email` is for display/audit only. All data access is scoped to `id`."""
    id: str
    email: str


_TOKEN_CACHE: dict[str, tuple[float, "User"]] = {}  # token -> (expires_at_monotonic, User)
_CACHE_TTL = 300


def login(email: str, password: str) -> dict:
    try:
        res = sb_auth().auth.sign_in_with_password({"email": email, "password": password})
    except Exception as e:
        log.warning("login failed for %s: %s", email, type(e).__name__)
        raise HTTPException(401, "invalid credentials")
    return {
        "access_token": res.session.access_token,
        "expires_in": res.session.expires_in,
        "email": res.user.email,
    }


def require_user(request: Request) -> User:
    """FastAPI dependency: returns the authenticated User (id + email) or raises 401.
    The `id` is the tenant owner_id every query must filter by."""
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token")
    token = header.split(" ", 1)[1].strip()

    cached = _TOKEN_CACHE.get(token)
    if cached and cached[0] > time.monotonic():
        return cached[1]

    try:
        res = sb_auth().auth.get_user(token)
        user = User(id=res.user.id, email=res.user.email)
    except Exception:
        raise HTTPException(401, "invalid or expired token")
    _TOKEN_CACHE[token] = (time.monotonic() + _CACHE_TTL, user)
    return user


# --- Cursor / MCP token → owner resolution ---------------------------------
# The MCP surface is identity-driven, NOT pinned to a demo tenant: a bearer token
# resolves to the owner who created it. Two accepted token kinds — a long-lived
# Cursor PAT (mcp_tokens, minted in the UI) or a raw Supabase session JWT. Whoever
# the token belongs to IS the tenant. (Do NOT regress: no anonymous MCP access;
# no hardcoded owner.)
_OWNER_CACHE: dict[str, tuple[float, str]] = {}  # token -> (expires_at, owner_id)
_OWNER_TTL = 30  # short so a revoked PAT stops working within ~30s


def owner_for_token(token: str) -> str | None:
    """Resolve a bearer token to its owner_id, or None if invalid/expired/revoked.
    Checks the Cursor PAT table first (fast, revocable), then a Supabase JWT."""
    if not token:
        return None
    cached = _OWNER_CACHE.get(token)
    if cached and cached[0] > time.monotonic():
        return cached[1]

    owner: str | None = None
    if token.startswith(MCP_TOKEN_PREFIX):
        row = (
            sb().table("mcp_tokens").select("owner_id")
            .eq("token", token).is_("revoked_at", "null").limit(1).execute().data
        )
        if row:
            owner = row[0]["owner_id"]
    else:  # a Supabase session JWT
        try:
            owner = sb_auth().auth.get_user(token).user.id
        except Exception:
            owner = None

    if owner:
        _OWNER_CACHE[token] = (time.monotonic() + _OWNER_TTL, owner)
    return owner


def mint_mcp_token(owner_id: str, label: str | None = None) -> dict:
    """Create a new Cursor PAT for this owner. Returns the raw token ONCE."""
    token = MCP_TOKEN_PREFIX + secrets.token_urlsafe(24)
    row = (
        sb().table("mcp_tokens")
        .insert({"owner_id": owner_id, "token": token, "label": label or "Cursor"})
        .execute().data[0]
    )
    return {"id": row["id"], "token": token, "label": row["label"], "created_at": row["created_at"]}


def list_mcp_tokens(owner_id: str) -> list[dict]:
    """Active (non-revoked) Cursor tokens for this owner — masked, never the raw value."""
    rows = (
        sb().table("mcp_tokens").select("id, label, token, created_at, last_used_at")
        .eq("owner_id", owner_id).is_("revoked_at", "null")
        .order("created_at", desc=True).execute().data
    )
    return [
        {"id": r["id"], "label": r["label"], "created_at": r["created_at"],
         "last_used_at": r["last_used_at"], "masked": r["token"][:11] + "…" + r["token"][-4:]}
        for r in rows
    ]


def revoke_mcp_token(owner_id: str, token_id: str) -> bool:
    """Revoke one of THIS owner's tokens (owner-scoped — can't revoke another tenant's)."""
    res = (
        sb().table("mcp_tokens").update({"revoked_at": "now()"})
        .eq("id", token_id).eq("owner_id", owner_id).is_("revoked_at", "null").execute()
    )
    return bool(res.data)

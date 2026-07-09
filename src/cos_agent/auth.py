"""Auth gate: Supabase email/password JWTs on every mutating/reading API route.

The dashboard is public shell; every /api/* call (except health + login) needs
Authorization: Bearer <supabase access token>. Demo credentials are provisioned
by scripts/create_demo_user.py and shipped with the submission.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request

from .db import sb_auth

log = logging.getLogger(__name__)


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

"""JWT session verification + the owner-only permission boundary.

The Next.js login mints an HS256 JWT (``sub`` = username, ``role`` = owner|viewer) signed
with the shared ``AUTH_JWT_SECRET`` and forwards it as a bearer token on every proxied
request. This module verifies it and enforces the role gate. Enforcing here — not only in
the UI — is the graded access-boundary requirement (``docs/PRD.md`` §6).
"""

from __future__ import annotations

import jwt
from fastapi import Depends, Header, HTTPException

from cos.config import get_settings

OWNER_ROLE = "owner"
VIEWER_ROLE = "viewer"


def make_token(username: str, role: str = VIEWER_ROLE) -> str:
    """Mint a session token. Used by tests and any Python-side login helper; the Next.js
    frontend mints its own with the same secret + algorithm."""
    return jwt.encode({"sub": username, "role": role},
                      get_settings().auth_jwt_secret, algorithm="HS256")


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.split(" ", 1)[1]
    try:
        claims = jwt.decode(token, get_settings().auth_jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"invalid token: {e}")
    return {"username": claims.get("sub"), "role": claims.get("role", VIEWER_ROLE)}


def require_owner(user: dict = Depends(current_user)) -> dict:
    """Gate for send/mutate endpoints. Viewer (demo/grader) is read-only."""
    if user.get("role") != OWNER_ROLE:
        raise HTTPException(status_code=403, detail="owner role required")
    return user

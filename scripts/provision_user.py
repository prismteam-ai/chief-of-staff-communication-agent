"""Provision (or fetch) a Supabase auth user via the GoTrue admin API.

Creates the user with email_confirm=true (no confirmation email) so it can log in
immediately. Idempotent: if the email already exists, returns that user's id.
Prints `id<TAB>email<TAB>password` on stdout; the password is only meaningful for a
freshly-created user. Never commit the printed password — store it in .env only.

Usage:  uv run python scripts/provision_user.py <email> [password]
"""
from __future__ import annotations

import secrets
import sys

import httpx

from cos_agent.config import settings


def provision(email: str, password: str) -> tuple[str, str, bool]:
    s = settings()
    base = s.supabase_url.rstrip("/")
    h = {
        "apikey": s.supabase_service_key,
        "Authorization": f"Bearer {s.supabase_service_key}",
        "Content-Type": "application/json",
    }
    # already exists?
    r = httpx.get(f"{base}/auth/v1/admin/users", headers=h, params={"page": 1, "per_page": 200}, timeout=30)
    r.raise_for_status()
    for u in r.json().get("users", []):
        if (u.get("email") or "").lower() == email.lower():
            return u["id"], email, False
    # create
    r = httpx.post(
        f"{base}/auth/v1/admin/users", headers=h,
        json={"email": email, "password": password, "email_confirm": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"], email, True


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: provision_user.py <email> [password]")
    email = sys.argv[1]
    password = sys.argv[2] if len(sys.argv) > 2 else secrets.token_urlsafe(16)
    uid, email, created = provision(email, password)
    print(f"{uid}\t{email}\t{password if created else '(existing — password unchanged)'}")


if __name__ == "__main__":
    main()

"""Connection status + credential application for the four providers.

Provider connectivity is driven by ``cos/config.py`` (``MODE`` + per-provider creds). This
module reports each provider's status and applies changes from the Connections UI. Since
``MODE`` is process-global, the **Mock-only** toggle flips the whole process to mock (the
default, needs no creds); switching a provider to real flips the process to real and injects
that provider's tokens into the environment, then clears the settings cache so the connectors
rebuild against the new config.
"""

from __future__ import annotations

import os

import httpx

from cos.config import get_settings

PROVIDERS = ("gmail", "whatsapp", "x", "asana")

# UI credential field -> environment variable, per provider
_CRED_ENV: dict[str, dict[str, str]] = {
    "gmail": {
        "client_id": "GOOGLE_CLIENT_ID",
        "client_secret": "GOOGLE_CLIENT_SECRET",
        "refresh_token": "GOOGLE_REFRESH_TOKEN",
    },
    "x": {
        "consumer_key": "X_CONSUMER_KEY",
        "consumer_secret": "X_CONSUMER_SECRET",
        "access_token": "X_ACCESS_TOKEN",
        "access_token_secret": "X_ACCESS_TOKEN_SECRET",
        "bearer_token": "X_BEARER_TOKEN",
    },
    "whatsapp": {
        "token": "WHATSAPP_TOKEN",
        "phone_id": "WHATSAPP_PHONE_ID",
        "verify_token": "WHATSAPP_VERIFY_TOKEN",
        "app_secret": "WHATSAPP_APP_SECRET",
    },
    "asana": {
        "token": "ASANA_TOKEN",
        "workspace_gid": "ASANA_WORKSPACE_GID",
    },
}


def _mock_reachable() -> bool:
    # Probe the root of the base URL the connectors actually use in mock mode.
    base = get_settings().gmail_base_url.rstrip("/")
    try:
        return httpx.get(f"{base}/", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


def _points_at_real(provider: str) -> bool:
    """True if this provider's base URL targets the real API rather than the mock. Lets a
    single provider (e.g. Asana) run real while others stay mock — MODE is not per-provider."""
    s = get_settings()
    url = {
        "gmail": s.gmail_base_url,
        "x": s.x_base_url,
        "whatsapp": s.whatsapp_base_url,
        "asana": s.asana_base_url,
    }.get(provider, "")
    real_hosts = ("gmail.googleapis.com", "api.twitter.com", "api.x.com",
                  "graph.facebook.com", "app.asana.com")
    return any(h in url for h in real_hosts)


def _real_connected(provider: str) -> bool:
    s = get_settings()
    if provider == "gmail":
        return bool(s.google_refresh_token)
    if provider == "x":
        return bool(s.x_consumer_key and s.x_access_token)
    if provider == "whatsapp":
        return bool(s.whatsapp_token) and s.whatsapp_token != "mock-whatsapp-token"
    if provider == "asana":
        return bool(s.asana_token) and s.asana_token != "mock-asana-token"
    return False


def status_for(provider: str) -> dict:
    # A provider is "real" if its base URL points at the real API (independent of the global
    # MODE), so mixed setups — e.g. Asana real while the rest stay mock — report accurately.
    if _points_at_real(provider):
        ok = _real_connected(provider)
        return {"provider": provider, "mode": "real", "connected": ok,
                "detail": "credentials present" if ok else "missing credentials"}
    ok = _mock_reachable()
    return {"provider": provider, "mode": "mock", "connected": ok,
            "detail": "mock" if ok else "mock server unreachable"}


def all_status() -> dict:
    s = get_settings()
    return {"mode": s.mode, "providers": [status_for(p) for p in PROVIDERS]}


def apply_update(provider: str, mode: str, credentials: dict[str, str]) -> dict:
    """Flip the process mode and, in real mode, inject this provider's creds. Returns the
    new status. Caller is responsible for rebuilding any cached KB."""
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider: {provider}")
    mode = (mode or "mock").lower()
    if mode not in ("mock", "real"):
        raise ValueError(f"mode must be mock|real, got {mode}")
    os.environ["MODE"] = mode
    if mode == "real":
        for field, value in (credentials or {}).items():
            env = _CRED_ENV.get(provider, {}).get(field)
            if env and value:
                os.environ[env] = value
    get_settings.cache_clear()
    return status_for(provider)

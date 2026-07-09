"""Gmail connector — real provider integration via the Gmail REST API.

Auth: Google OAuth web flow (routes in api.py) stores a refresh token in
connector_tokens; this connector mints access tokens from it on demand.
Scopes: gmail.readonly + gmail.send. Defensive parsing throughout: one
malformed message never kills a sync.
"""
from __future__ import annotations

import base64
import logging
import os
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Iterable

import httpx

from ..db import sb
from .base import RawMessage

log = logging.getLogger(__name__)

TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"


def stored_accounts() -> list[dict]:
    try:
        return sb().table("connector_tokens").select("account_handle, refresh_token").eq("channel", "gmail").execute().data
    except Exception:
        return []


class GmailConnector:
    channel = "gmail"

    def __init__(self, account_handle: str, refresh_token: str) -> None:
        self.account_handle = account_handle
        self._refresh_token = refresh_token
        self._access: tuple[str, float] | None = None  # (token, expiry_monotonic)

    # -- auth ---------------------------------------------------------------
    def _token(self) -> str:
        if self._access and self._access[1] > time.monotonic() + 60:
            return self._access[0]
        r = httpx.post(TOKEN_URL, data={
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": self._refresh_token,
            "grant_type": "refresh_token",
        }, timeout=30)
        r.raise_for_status()
        d = r.json()
        self._access = (d["access_token"], time.monotonic() + int(d.get("expires_in", 3600)))
        return self._access[0]

    def _get(self, path: str, **params) -> dict:
        r = httpx.get(f"{GMAIL}{path}", headers={"Authorization": f"Bearer {self._token()}"},
                      params=params, timeout=30)
        r.raise_for_status()
        return r.json()

    # -- fetch ----------------------------------------------------------------
    # Gmail lists newest-first, so fetching the newest page each sync catches new
    # arrivals cheaply; the store dedups the rest. (A full history backfill is a
    # one-time concern, not something to repeat on every 5-minute sync — re-pulling
    # 500 messages per cycle blew the request budget.)
    FETCH_LIMIT = 50

    def fetch(self) -> Iterable[RawMessage]:
        page_token = None
        fetched = 0
        while True:
            params: dict = {"maxResults": 50}
            if page_token:
                params["pageToken"] = page_token
            listing = self._get("/messages", **params)
            for stub in listing.get("messages", []):
                try:
                    yield self._to_raw(self._get(f"/messages/{stub['id']}", format="full"))
                    fetched += 1
                except Exception as e:  # defensive: skip the bad one, keep the sync
                    log.warning("gmail: skipping message %s (%s: %s)", stub.get("id"), type(e).__name__, e)
            page_token = listing.get("nextPageToken")
            if not page_token or fetched >= self.FETCH_LIMIT:
                return

    def _to_raw(self, msg: dict) -> RawMessage:
        headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
        from_name, from_addr = parseaddr(headers.get("from", ""))
        to_pairs = [parseaddr(x) for x in headers.get("to", "").split(",") if x.strip()]
        is_self = from_addr.lower() == self.account_handle.lower()
        sent_at = datetime.fromtimestamp(int(msg.get("internalDate", "0")) / 1000, tz=timezone.utc)
        attachments = [
            {"filename": p.get("filename"), "mime": p.get("mimeType"), "size": p.get("body", {}).get("size")}
            for p in msg.get("payload", {}).get("parts", []) or [] if p.get("filename")
        ]
        return RawMessage(
            channel="gmail",
            account_handle=self.account_handle,
            external_id=msg["id"],
            external_thread_id=msg.get("threadId", msg["id"]),
            direction="outbound" if is_self else "inbound",
            sender={"handle": from_addr, "display_name": from_name or from_addr},
            recipients=[{"handle": a, "display_name": n or a} for n, a in to_pairs],
            body_text=_body_text(msg.get("payload", {})) or headers.get("subject", ""),
            subject=headers.get("subject"),
            sent_at=sent_at,
            attachments=attachments,
            raw_ref=f"gmail:{self.account_handle}:{msg['id']}",
        )

    # -- send -----------------------------------------------------------------
    def send(self, to: list[dict], body: str, thread_external_id: str | None,
             subject: str | None = None) -> str:
        em = EmailMessage()
        em["To"] = ", ".join(t["handle"] for t in to)
        em["From"] = self.account_handle
        subj = (subject or "").strip()
        if subj and not subj.lower().startswith("re:"):
            subj = f"Re: {subj}"
        em["Subject"] = subj or "Re: (via Chief of Staff agent)"
        em.set_content(body)
        payload: dict = {"raw": base64.urlsafe_b64encode(em.as_bytes()).decode()}
        if thread_external_id:
            payload["threadId"] = thread_external_id
        r = httpx.post(f"{GMAIL}/messages/send",
                       headers={"Authorization": f"Bearer {self._token()}"},
                       json=payload, timeout=30)
        r.raise_for_status()
        return r.json()["id"]


def _body_text(payload: dict) -> str:
    """Prefer text/plain; recurse into multiparts; decode base64url defensively."""
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        try:
            return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", "replace")[:8000]
        except Exception:
            return ""
    for part in payload.get("parts", []) or []:
        text = _body_text(part)
        if text:
            return text
    return ""


def oauth_start_url(state: str) -> str:
    from urllib.parse import urlencode

    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
        "client_id": os.environ["GOOGLE_CLIENT_ID"],
        "redirect_uri": os.environ.get("GOOGLE_REDIRECT_URI",
                                       "https://cos-comms-agent.onrender.com/api/oauth/google/callback"),
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",       # force refresh_token issuance
        "state": state,
    })


def oauth_exchange(code: str) -> dict:
    r = httpx.post(TOKEN_URL, data={
        "client_id": os.environ["GOOGLE_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": os.environ.get("GOOGLE_REDIRECT_URI",
                                       "https://cos-comms-agent.onrender.com/api/oauth/google/callback"),
    }, timeout=30)
    r.raise_for_status()
    tokens = r.json()
    profile = httpx.get(f"{GMAIL}/profile",
                        headers={"Authorization": f"Bearer {tokens['access_token']}"}, timeout=30).json()
    return {"refresh_token": tokens.get("refresh_token"), "email": profile.get("emailAddress")}

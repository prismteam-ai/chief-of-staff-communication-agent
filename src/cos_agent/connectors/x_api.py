"""X (Twitter) DM connector — full implementation, credential-gated.

Activates when X_USER_ACCESS_TOKEN is set (OAuth2 user context, scopes
dm.read dm.write tweet.read users.read — provided by the company).
Endpoint shapes per docs.x.com (verified 2026-07-08: GET /2/dm_events,
POST /2/dm_conversations/with/:participant_id/messages); marked unverified
against the live API until credentials arrive.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Iterable

import httpx

from .base import RawMessage

log = logging.getLogger(__name__)
X_API = "https://api.x.com/2"


class XConnector:
    channel = "x"

    def __init__(self) -> None:
        self.token = os.environ["X_USER_ACCESS_TOKEN"]
        self.self_user_id = os.environ["X_SELF_USER_ID"]      # numeric id of the exec's account
        self.self_handle = os.environ.get("X_SELF_HANDLE", "@self")

    def _h(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def fetch(self) -> Iterable[RawMessage]:
        params: dict = {
            "event_types": "MessageCreate",
            "dm_event.fields": "id,text,created_at,sender_id,dm_conversation_id",
            "expansions": "sender_id",
            "user.fields": "username,name",
            "max_results": 100,
        }
        next_token = None
        while True:
            if next_token:
                params["pagination_token"] = next_token
            r = httpx.get(f"{X_API}/dm_events", headers=self._h(), params=params, timeout=30)
            r.raise_for_status()
            payload = r.json()
            users = {u["id"]: u for u in payload.get("includes", {}).get("users", [])}
            for ev in payload.get("data", []):
                sender = users.get(ev.get("sender_id"), {})
                is_self = ev.get("sender_id") == self.self_user_id
                who = {
                    "handle": f"@{sender.get('username', ev.get('sender_id'))}",
                    "display_name": sender.get("name"),
                }
                yield RawMessage(
                    channel="x",
                    account_handle=self.self_handle,
                    external_id=ev["id"],
                    external_thread_id=ev.get("dm_conversation_id", ev["id"]),
                    direction="outbound" if is_self else "inbound",
                    sender={"handle": self.self_handle, "display_name": "self"} if is_self else who,
                    recipients=[who] if is_self else [{"handle": self.self_handle}],
                    body_text=ev.get("text", ""),
                    sent_at=datetime.fromisoformat(ev["created_at"].replace("Z", "+00:00")),
                    raw_ref=f"x:dm_events:{ev['id']}",
                )
            next_token = payload.get("meta", {}).get("next_token")
            if not next_token:
                return

    def send(self, to: list[dict], body: str, thread_external_id: str | None) -> str:
        # DM back the counterpart in the conversation; requires their numeric id
        participant = (to[0].get("participant_id") or to[0].get("handle", "")).lstrip("@")
        r = httpx.post(
            f"{X_API}/dm_conversations/with/{participant}/messages",
            headers=self._h(), json={"text": body}, timeout=30,
        )
        r.raise_for_status()
        return r.json().get("data", {}).get("dm_event_id", "x-sent")


def available() -> bool:
    ok = bool(os.environ.get("X_USER_ACCESS_TOKEN") and os.environ.get("X_SELF_USER_ID"))
    if not ok:
        log.info("x connector: credentials absent — staying in fixture mode")
    return ok

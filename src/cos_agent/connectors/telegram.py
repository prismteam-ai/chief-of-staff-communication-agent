"""Telegram connector — free Bot API, no OAuth. Activates when TELEGRAM_BOT_TOKEN
is set (a paste-key credential, like Asana's PAT).

Inbound via getUpdates (long-poll REST — fits our poll-based ingest cleanly);
outbound via sendMessage. Store dedups on external_id, so re-fetching the same
updates (Telegram keeps them ~24h until confirmed) never duplicates.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Iterable

import httpx

from .base import RawMessage

log = logging.getLogger(__name__)


def _token() -> str:
    return os.environ["TELEGRAM_BOT_TOKEN"]


def _api(method: str) -> str:
    return f"https://api.telegram.org/bot{_token()}/{method}"


@lru_cache
def _bot_handle() -> str:
    try:
        me = httpx.get(_api("getMe"), timeout=15).json()["result"]
        return "@" + me.get("username", "cos_bot")
    except Exception:
        return "@cos_bot"


class TelegramConnector:
    channel = "telegram"

    def __init__(self) -> None:
        self.account_handle = _bot_handle()

    def fetch(self) -> Iterable[RawMessage]:
        r = httpx.get(_api("getUpdates"), params={"timeout": 0, "allowed_updates": '["message"]'}, timeout=30)
        r.raise_for_status()
        for u in r.json().get("result", []):
            m = u.get("message")
            if not m or "text" not in m:
                continue  # skip non-text (stickers, joins, etc.)
            chat, frm = m["chat"], m.get("from", {})
            name = (f"{frm.get('first_name', '')} {frm.get('last_name', '')}".strip()
                    or frm.get("username") or str(frm.get("id")))
            handle = f"@{frm['username']}" if frm.get("username") else str(frm.get("id"))
            yield RawMessage(
                channel="telegram",
                account_handle=self.account_handle,
                external_id=f"{chat['id']}-{m['message_id']}",
                external_thread_id=str(chat["id"]),
                direction="inbound",
                sender={"handle": handle, "display_name": name},
                recipients=[{"handle": self.account_handle}],
                body_text=m["text"],
                sent_at=datetime.fromtimestamp(m["date"], tz=timezone.utc),
                raw_ref=f"telegram:{chat['id']}:{m['message_id']}",
            )

    def send(self, to: list[dict], body: str, thread_external_id: str | None) -> str:
        chat_id = thread_external_id or (to[0].get("handle") if to else None)
        r = httpx.post(_api("sendMessage"), json={"chat_id": chat_id, "text": body}, timeout=30)
        r.raise_for_status()
        return str(r.json()["result"]["message_id"])


def available() -> bool:
    ok = bool(os.environ.get("TELEGRAM_BOT_TOKEN"))
    if not ok:
        log.info("telegram connector: TELEGRAM_BOT_TOKEN absent — not registered")
    return ok

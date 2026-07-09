"""Telegram connector — the user's PERSONAL account via MTProto (Telethon), NOT a bot.

Reads and sends real messages from the user's own Telegram account. Credential
(connector_tokens.refresh_token) is a JSON blob the Connections UI stores:
{"api_id","api_hash","session"} — where `session` is a Telethon StringSession
produced by running scripts/telegram_login.py locally (a one-time phone-code login).
api_id/api_hash come from my.telegram.org.

Telethon is async; the Connector protocol is sync. ingest/send call these from a worker
thread (FastAPI runs the sync sync-path in a threadpool; autosync uses asyncio.to_thread),
so there is no running event loop in that thread and asyncio.run() is safe. A fresh client
is created per call — fine at demo cadence; a pooled client is a later optimization.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import timezone
from typing import Iterable

from telethon import TelegramClient
from telethon.sessions import StringSession

from .base import RawMessage

log = logging.getLogger(__name__)
DIALOG_LIMIT = 20   # most-recent 1:1 conversations
MSG_LIMIT = 20      # most-recent messages per conversation


class TelegramUserConnector:
    channel = "telegram"

    def __init__(self, account_handle: str, secret: str) -> None:
        cfg = json.loads(secret)
        self.api_id = int(cfg["api_id"])
        self.api_hash = cfg["api_hash"]
        self._session = cfg["session"]
        self.account_handle = account_handle  # phone / @handle label

    def _client(self) -> TelegramClient:
        return TelegramClient(StringSession(self._session), self.api_id, self.api_hash)

    # -- fetch ----------------------------------------------------------------
    def fetch(self) -> Iterable[RawMessage]:
        return iter(asyncio.run(self._collect()))

    async def _collect(self) -> list[RawMessage]:
        out: list[RawMessage] = []
        client = self._client()
        await client.connect()
        try:
            if not await client.is_user_authorized():
                raise RuntimeError("Telegram session not authorized — re-run scripts/telegram_login.py")
            me = await client.get_me()
            self_handle = ("@" + me.username) if getattr(me, "username", None) else str(me.id)
            async for dialog in client.iter_dialogs(limit=DIALOG_LIMIT):
                if not dialog.is_user:          # only 1:1 person chats (skip groups/channels)
                    continue
                peer = dialog.entity
                if getattr(peer, "bot", False):  # skip bots
                    continue
                peer_handle = ("@" + peer.username) if getattr(peer, "username", None) else str(peer.id)
                peer_name = " ".join(filter(None, [getattr(peer, "first_name", None),
                                                   getattr(peer, "last_name", None)])) or peer_handle
                async for msg in client.iter_messages(peer, limit=MSG_LIMIT):
                    if not msg.message:  # skip media-only / service messages
                        continue
                    sent_at = msg.date
                    if sent_at.tzinfo is None:
                        sent_at = sent_at.replace(tzinfo=timezone.utc)
                    out.append(RawMessage(
                        channel="telegram",
                        account_handle=self.account_handle,
                        external_id=f"{peer.id}:{msg.id}",
                        external_thread_id=str(peer.id),
                        direction="outbound" if msg.out else "inbound",
                        sender=({"handle": self_handle, "display_name": "you"} if msg.out
                                else {"handle": peer_handle, "display_name": peer_name}),
                        recipients=[{"handle": peer_handle if msg.out else self_handle}],
                        body_text=msg.message,
                        sent_at=sent_at,
                        raw_ref=f"telegram:{peer.id}:{msg.id}",
                    ))
        finally:
            await client.disconnect()
        return out

    # -- send -----------------------------------------------------------------
    def send(self, to: list[dict], body: str, thread_external_id: str | None,
             subject: str | None = None) -> str:
        return asyncio.run(self._asend(to, body, thread_external_id))

    async def _asend(self, to: list[dict], body: str, thread_external_id: str | None) -> str:
        client = self._client()
        await client.connect()
        try:
            # Prefer an @username (resolves reliably on a fresh client); fall back to the
            # numeric peer id from the thread.
            handle = (to[0].get("handle") if to else "") or ""
            if handle.startswith("@"):
                target: object = handle
            elif thread_external_id and thread_external_id.lstrip("-").isdigit():
                target = int(thread_external_id)
            else:
                target = handle or thread_external_id
            msg = await client.send_message(target, body)
            return str(msg.id)
        finally:
            await client.disconnect()

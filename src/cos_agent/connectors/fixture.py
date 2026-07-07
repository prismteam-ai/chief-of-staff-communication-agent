"""Fixture connector: the mock-first dev loop (CLAUDE.md engineering default).

Reads data/fixtures/<channel>.json so ingest, RAG, brain, and UI iterate
without live provider calls. Real connectors (gmail, twilio, ...) implement
the same protocol and replace these per channel when credentials land.
Sends write to data/outbox/<channel>/ — an auditable fake provider.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from ..config import settings
from .base import RawMessage


class FixtureConnector:
    def __init__(self, channel: str) -> None:
        self.channel = channel
        self._path = Path(settings().fixture_dir) / f"{channel}.json"

    def fetch(self) -> Iterable[RawMessage]:
        if not self._path.exists():
            raise FileNotFoundError(f"no fixture corpus at {self._path}")
        data = json.loads(self._path.read_text())
        for i, m in enumerate(data["messages"]):
            yield RawMessage(
                channel=self.channel,
                account_handle=m["account_handle"],
                external_id=m["external_id"],
                external_thread_id=m["external_thread_id"],
                direction=m["direction"],
                sender=m["sender"],
                recipients=m["recipients"],
                body_text=m["body_text"],
                subject=m.get("subject"),
                sent_at=datetime.fromisoformat(m["sent_at"]),
                attachments=m.get("attachments", []),
                raw_ref=f"{self._path}#{i}",
            )

    def send(self, to: list[dict], body: str, thread_external_id: str | None) -> str:
        out = Path(settings().outbox_dir) / self.channel
        out.mkdir(parents=True, exist_ok=True)
        msg_id = f"{self.channel}-out-{uuid.uuid4().hex[:10]}"
        (out / f"{msg_id}.json").write_text(json.dumps({
            "id": msg_id,
            "to": to,
            "body": body,
            "thread": thread_external_id,
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }, indent=2))
        return msg_id

"""Inbound buffer for real-mode WhatsApp.

The Cloud API has no pollable "list inbound" endpoint — messages are pushed to a webhook.
The webhook receiver (``cos.webhooks.whatsapp``) appends each delivery here; the connector
drains it in ``MODE=real``. The buffer stores raw Cloud API ``messages``/``contacts`` dicts
so the connector's existing parsing is unchanged between mock and real.

File-backed JSON keeps it dependency-free and lets the webhook process and the ingest
process share state on one host; point ``WHATSAPP_INBOX_PATH`` at shared storage (or swap
this module for a queue/DB) for a multi-host deployment.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_DEFAULT_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "data" / "whatsapp_inbox.json"


def _path() -> Path:
    return Path(os.environ.get("WHATSAPP_INBOX_PATH", str(_DEFAULT_PATH)))


def _empty() -> dict:
    return {"messages": [], "contacts": []}


def read() -> dict:
    """Return the buffered ``{"messages": [...], "contacts": [...]}`` (never raises)."""
    p = _path()
    if not p.exists():
        return _empty()
    try:
        data = json.loads(p.read_text() or "{}")
    except (ValueError, OSError):
        return _empty()
    data.setdefault("messages", [])
    data.setdefault("contacts", [])
    return data


def append(messages: list[dict], contacts: list[dict] | None = None) -> None:
    """Append a webhook delivery's messages/contacts, de-duping contacts by wa_id."""
    data = read()
    data["messages"].extend(messages)
    seen = {c.get("wa_id") for c in data["contacts"]}
    for c in contacts or []:
        if c.get("wa_id") not in seen:
            data["contacts"].append(c)
            seen.add(c.get("wa_id"))
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))


def drain() -> dict:
    """Return the buffer and clear it, so each message is ingested once."""
    data = read()
    if data["messages"]:
        _path().write_text(json.dumps(_empty()))
    return data


def clear() -> None:
    p = _path()
    if p.exists():
        p.write_text(json.dumps(_empty()))

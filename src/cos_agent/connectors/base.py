"""Connector interface: one shape per channel, modular by design.

A connector yields RawMessage batches from a provider and can send an
approved reply back through the same provider. Adding a channel means
implementing this protocol and registering it — nothing else changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Protocol


@dataclass
class RawMessage:
    channel: str
    account_handle: str          # which of our accounts this belongs to
    external_id: str
    external_thread_id: str
    direction: str               # inbound | outbound
    sender: dict                 # {handle, display_name}
    recipients: list[dict]
    body_text: str
    sent_at: datetime
    subject: str | None = None
    attachments: list[dict] = field(default_factory=list)
    raw_ref: str = ""            # provenance pointer to the raw record


class Connector(Protocol):
    channel: str

    def fetch(self) -> Iterable[RawMessage]:
        """Yield all currently available messages (idempotent; store dedups)."""
        ...

    def send(self, to: list[dict], body: str, thread_external_id: str | None) -> str:
        """Send an approved reply. Returns provider message id."""
        ...


_REGISTRY: dict[str, Connector] = {}


def register(conn: Connector) -> None:
    _REGISTRY[conn.channel] = conn


def get(channel: str) -> Connector:
    if channel not in _REGISTRY:
        raise LookupError(
            f"no connector registered for channel '{channel}' (have: {sorted(_REGISTRY)})"
        )
    return _REGISTRY[channel]


def all_connectors() -> list[Connector]:
    return list(_REGISTRY.values())

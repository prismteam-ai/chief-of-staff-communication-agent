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

    def send(self, to: list[dict], body: str, thread_external_id: str | None,
             subject: str | None = None) -> str:
        """Send an approved reply. Returns provider message id. `subject` is used by
        email channels (Gmail/IMAP) to reply under the original subject; channels
        without subjects (DMs/SMS/Telegram) ignore it."""
        ...


# Connectors are resolved PER TENANT from stored credentials — see
# connectors/resolve.py. There is no global registry: a connector belongs to the
# owner whose token built it, so cross-tenant sends are impossible by construction.

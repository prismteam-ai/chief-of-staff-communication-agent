"""Per-owner connector resolution — the multi-tenant replacement for the old
global registry.

A connector belongs to a tenant: it is built from that owner's stored credentials
in connector_tokens (Gmail refresh token, IMAP app-password, Telegram session, …).
There is no shared/global connector and no fixture fallback — real integrations
only. A channel a tenant hasn't connected simply isn't available to them.
"""
from __future__ import annotations

import logging
from typing import Callable

from ..db import sb
from .base import Connector

log = logging.getLogger(__name__)


def _build_gmail(tok: dict) -> Connector:
    from .gmail_api import GmailConnector
    return GmailConnector(tok["account_handle"], tok["refresh_token"])


def _build_imap(tok: dict) -> Connector:
    from .imap_email import ImapConnector
    return ImapConnector(tok["account_handle"], tok["refresh_token"])


def _build_telegram(tok: dict) -> Connector:
    from .telegram_user import TelegramUserConnector
    return TelegramUserConnector(tok["account_handle"], tok["refresh_token"])


def _build_x(tok: dict) -> Connector:
    from .x_api import XConnector
    return XConnector(tok["account_handle"], tok["refresh_token"])


def _build_twilio(channel: str) -> Callable[[dict], Connector]:
    def build(tok: dict) -> Connector:
        from .twilio import TwilioConnector
        return TwilioConnector(channel, tok["account_handle"], tok["refresh_token"])
    return build


# channel -> factory from a connector_tokens row
_BUILDERS: dict[str, Callable[[dict], Connector]] = {
    "gmail": _build_gmail,
    "email": _build_imap,
    "telegram": _build_telegram,
    "x": _build_x,
    "sms": _build_twilio("sms"),
    "whatsapp": _build_twilio("whatsapp"),
}


def _tokens(owner: str) -> list[dict]:
    return (
        sb().table("connector_tokens")
        .select("channel, account_handle, refresh_token, scopes")
        .eq("owner_id", owner).execute().data
    )


def connectors_for_owner(owner: str) -> list[Connector]:
    """Every real connector this tenant has connected (one per connected account)."""
    out: list[Connector] = []
    for tok in _tokens(owner):
        build = _BUILDERS.get(tok["channel"])
        if not build:
            log.info("no connector builder for channel %s (owner %s) — skipping", tok["channel"], owner)
            continue
        try:
            out.append(build(tok))
        except Exception as e:  # a bad credential never blocks the other channels
            log.warning("failed to build %s connector for %s: %s", tok["channel"], owner, e)
    return out


def connector_for(owner: str, channel: str) -> Connector:
    """The tenant's connector for one channel (for the send path). Raises LookupError
    if the tenant has not connected that channel."""
    build = _BUILDERS.get(channel)
    if not build:
        raise LookupError(f"channel '{channel}' has no real connector implementation")
    for tok in _tokens(owner):
        if tok["channel"] == channel:
            return build(tok)
    raise LookupError(f"owner {owner} has not connected channel '{channel}'")

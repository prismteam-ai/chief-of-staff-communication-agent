"""Twilio connector — SMS and WhatsApp, per tenant.

The user connects their OWN Twilio account (Twilio charges for numbers + messages —
"bring your own paid credentials"). Credential (connector_tokens.refresh_token) is a
JSON blob the Connections UI builds: {"account_sid","auth_token","from_number"}.
WhatsApp uses the same REST API with a whatsapp: address prefix.

NOTE: built against Twilio's stable Messages REST API; verify live against a real
Twilio account before treating a channel as proven (no sandbox creds wired here).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable

import httpx

from .base import RawMessage

log = logging.getLogger(__name__)
FETCH_LIMIT = 50


def _clean(num: str) -> str:
    return (num or "").replace("whatsapp:", "")


class TwilioConnector:
    def __init__(self, channel: str, account_handle: str, secret: str) -> None:
        cfg = json.loads(secret)
        self.channel = channel  # "sms" | "whatsapp"
        self.account_sid = cfg["account_sid"]
        self.auth_token = cfg["auth_token"]
        self.from_number = cfg["from_number"]
        self.account_handle = account_handle
        self._wa = channel == "whatsapp"

    def _url(self) -> str:
        return f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json"

    def _auth(self) -> tuple[str, str]:
        return (self.account_sid, self.auth_token)

    def fetch(self) -> Iterable[RawMessage]:
        r = httpx.get(self._url(), auth=self._auth(), params={"PageSize": FETCH_LIMIT}, timeout=30)
        r.raise_for_status()
        for m in r.json().get("messages", []):
            try:
                inbound = m.get("direction") == "inbound"
                # WhatsApp messages carry whatsapp: on both numbers; SMS won't. Keep this
                # connector to its own medium so SMS and WhatsApp stay separate channels.
                if self._wa != ("whatsapp:" in (m.get("from", "") + m.get("to", ""))):
                    continue
                frm, to = _clean(m.get("from", "")), _clean(m.get("to", ""))
                raw_date = m.get("date_sent") or m.get("date_created")
                try:
                    sent_at = parsedate_to_datetime(raw_date) if raw_date else datetime.now(timezone.utc)
                    if sent_at.tzinfo is None:
                        sent_at = sent_at.replace(tzinfo=timezone.utc)
                except Exception:
                    sent_at = datetime.now(timezone.utc)
                yield RawMessage(
                    channel=self.channel,
                    account_handle=self.account_handle,
                    external_id=m["sid"],
                    external_thread_id=frm if inbound else to,  # thread by the counterpart's number
                    direction="inbound" if inbound else "outbound",
                    sender={"handle": frm, "display_name": frm},
                    recipients=[{"handle": to}],
                    body_text=m.get("body") or "",
                    sent_at=sent_at,
                    raw_ref=f"twilio:{self.channel}:{m['sid']}",
                )
            except Exception as e:  # defensive: one bad record never kills the sync
                log.warning("twilio: skipping message (%s: %s)", type(e).__name__, e)

    def send(self, to: list[dict], body: str, thread_external_id: str | None,
             subject: str | None = None) -> str:
        num = _clean(to[0].get("handle")) if to else _clean(thread_external_id or "")
        to_addr = f"whatsapp:{num}" if self._wa else num
        from_addr = f"whatsapp:{_clean(self.from_number)}" if self._wa else self.from_number
        r = httpx.post(self._url(), auth=self._auth(),
                       data={"From": from_addr, "To": to_addr, "Body": body}, timeout=30)
        r.raise_for_status()
        return r.json()["sid"]

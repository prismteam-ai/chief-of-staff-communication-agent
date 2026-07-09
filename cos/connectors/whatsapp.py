"""WhatsApp connector — Meta Cloud API over httpx.

The Cloud API delivers inbound messages via webhooks, not a pollable list. In mock mode we
read them from the mock's convenience GET; in real mode we drain the buffer filled by the
webhook receiver (``cos.webhooks.whatsapp``). Either way the payload shape — raw Cloud API
``messages``/``contacts`` — is identical, so the parsing below is unchanged. The send path
(POST /<version>/<phone_id>/messages) matches the real Cloud API exactly.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from cos.config import get_settings
from cos.connectors import whatsapp_inbox
from cos.connectors.base import Connector
from cos.models import Channel, Direction, Message, Participant


class WhatsAppConnector(Connector):
    channel = Channel.whatsapp

    def __init__(self) -> None:
        self.s = get_settings()
        self.base = (f"{self.s.whatsapp_base_url}/{self.s.whatsapp_api_version}/"
                     f"{self.s.whatsapp_phone_id}/messages")
        self.headers = {"Authorization": f"Bearer {self.s.whatsapp_token}"}

    def _fetch_payload(self) -> dict:
        if self.s.is_mock:
            resp = httpx.get(self.base, headers=self.headers, timeout=10)
            resp.raise_for_status()
            return resp.json()
        # real mode: webhook-delivered messages, drained so each is ingested once
        return whatsapp_inbox.drain()

    def list_incoming(self) -> list[Message]:
        payload = self._fetch_payload()
        names = {c["wa_id"]: c["profile"]["name"]
                 for c in payload.get("contacts", [])}
        out = []
        for m in payload.get("messages", []):
            wa_id = m["from"]
            ts = datetime.fromtimestamp(int(m["timestamp"]), timezone.utc)
            sender = Participant(id=f"wa:{wa_id}", name=names.get(wa_id, wa_id),
                                 handle=f"+{wa_id}")
            out.append(Message(
                id=f"whatsapp:{m['id']}", channel=Channel.whatsapp,
                thread_id=f"wa:{wa_id}", sender=sender, timestamp=ts,
                body=m.get("text", {}).get("body", ""), direction=Direction.incoming,
                provenance={"provider": "whatsapp", "id": m["id"]}))
        return out

    def send_reply(self, thread_id: str, text: str, to: str | None = None) -> dict:
        recipient = (to or thread_id).replace("wa:", "").lstrip("+")
        body = {"messaging_product": "whatsapp", "to": recipient,
                "type": "text", "text": {"body": text}}
        resp = httpx.post(self.base, headers=self.headers, json=body, timeout=10)
        resp.raise_for_status()
        return resp.json()

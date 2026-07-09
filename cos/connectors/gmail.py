"""Gmail connector — real google-api-python-client, pointed at the mock via api_endpoint.

In mock mode we pass a dummy OAuth token and override the API root; the bundled static
discovery doc means ``build`` never hits the network. In real mode we build real user
credentials from a stored refresh token (the client auto-refreshes the access token) and
point at the real ``https://gmail.googleapis.com`` root — the mapping code is unchanged.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from email.utils import parseaddr

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from cos.config import get_settings
from cos.connectors.base import Connector
from cos.models import Channel, Direction, Message, Participant


class GmailConnector(Connector):
    channel = Channel.gmail

    def __init__(self) -> None:
        self.s = get_settings()
        self.service = build(
            "gmail", "v1", credentials=self._credentials(), static_discovery=True,
            client_options={"api_endpoint": self.s.gmail_base_url},
        )

    def _credentials(self) -> Credentials:
        """Dummy token offline; a real refresh-token credential in real mode."""
        if self.s.is_mock:
            # The static discovery doc means build() never hits the network, so any
            # non-empty token satisfies the client without a real OAuth exchange.
            return Credentials(token="mock-token")
        if not self.s.google_refresh_token:
            raise RuntimeError(
                "MODE=real needs GOOGLE_REFRESH_TOKEN (+ client id/secret). "
                "See RUNNING.md for the one-time consent step.")
        # token=None forces a refresh from the refresh token on first request.
        return Credentials(
            token=None,
            refresh_token=self.s.google_refresh_token,
            token_uri=self.s.google_token_uri,
            client_id=self.s.google_client_id,
            client_secret=self.s.google_client_secret,
            scopes=self.s.google_scope_list,
        )

    def list_incoming(self) -> list[Message]:
        api = self.service.users().messages()
        listing = api.list(userId=self.s.gmail_user_id, labelIds="INBOX").execute()
        out: list[Message] = []
        for ref in listing.get("messages", []):
            raw = api.get(userId=self.s.gmail_user_id, id=ref["id"],
                          format="full").execute()
            out.append(self._to_message(raw))
        return out

    def send_reply(self, thread_id: str, text: str, to: str | None = None) -> dict:
        mime = (f"From: {self.s.owner_email}\r\nTo: {to or ''}\r\n"
                f"Subject: Re:\r\n\r\n{text}")
        raw = base64.urlsafe_b64encode(mime.encode()).decode()
        return self.service.users().messages().send(
            userId=self.s.gmail_user_id, body={"raw": raw, "threadId": thread_id}
        ).execute()

    def _to_message(self, raw: dict) -> Message:
        headers = {h["name"].lower(): h["value"] for h in
                   raw.get("payload", {}).get("headers", [])}
        from_name, from_email = parseaddr(headers.get("from", ""))
        body_data = raw.get("payload", {}).get("body", {}).get("data", "")
        body = raw.get("snippet", "")
        if body_data:
            try:
                body = base64.urlsafe_b64decode(body_data).decode(errors="replace")
            except (ValueError, TypeError):   # malformed base64 -> fall back to snippet
                body = raw.get("snippet", "")
        outgoing = from_email.lower() == self.s.owner_email.lower()
        ts = datetime.fromtimestamp(int(raw.get("internalDate", "0")) / 1000, timezone.utc)
        sender = Participant(
            id=f"email:{from_email}", name=from_name or from_email,
            email=from_email, handle=from_email,
            is_owner=outgoing,
        )
        return Message(
            id=f"gmail:{raw['id']}", channel=Channel.gmail, thread_id=raw["threadId"],
            sender=sender, timestamp=ts, subject=headers.get("subject") or None,
            body=body,
            direction=Direction.outgoing if outgoing else Direction.incoming,
            provenance={"provider": "gmail", "id": raw["id"],
                        "thread_id": raw["threadId"]},
        )

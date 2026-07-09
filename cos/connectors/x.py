"""X (Twitter) connector — real tweepy client, redirected to the mock.

tweepy hardcodes ``https://api.twitter.com`` inside ``Client.request``, so in mock mode we
mount a requests adapter that rewrites that host to our mock base URL (endpoint
monkeypatching) and use bearer-only auth. In real mode we skip the adapter and pass the
full OAuth1 user context (consumer + access token/secret) alongside the bearer token, so
DMs and posting — which require user context, not app-only auth — work. The tweepy calls
and mapping code are identical either way.
"""

from __future__ import annotations

from datetime import datetime, timezone

import requests
import tweepy

from cos.config import get_settings
from cos.connectors.base import Connector
from cos.models import Channel, Direction, Message, Participant

_REAL_HOST = "https://api.twitter.com"


class _RedirectAdapter(requests.adapters.HTTPAdapter):
    """Rewrite the real X host to the local mock base for every outgoing request."""

    def __init__(self, target_base: str, *a, **k) -> None:
        self.target_base = target_base.rstrip("/")
        super().__init__(*a, **k)

    def send(self, request, **kwargs):
        if request.url.startswith(_REAL_HOST):
            request.url = self.target_base + request.url[len(_REAL_HOST):]
        return super().send(request, **kwargs)


class XConnector(Connector):
    channel = Channel.x

    def __init__(self) -> None:
        self.s = get_settings()
        if self.s.is_mock:
            # bearer-only + host redirect; the mock doesn't verify OAuth1 signatures
            self.client = tweepy.Client(bearer_token=self.s.x_bearer_token)
            self.client.session.mount(_REAL_HOST, _RedirectAdapter(self.s.x_base_url))
        else:
            # full user context: bearer for reads, OAuth1 for DMs + create_tweet
            missing = [n for n in ("x_consumer_key", "x_consumer_secret",
                                   "x_access_token", "x_access_token_secret")
                       if not getattr(self.s, n)]
            if missing:
                raise RuntimeError(
                    f"MODE=real needs X OAuth1 creds: {', '.join(missing)}")
            self.client = tweepy.Client(
                bearer_token=self.s.x_bearer_token,
                consumer_key=self.s.x_consumer_key,
                consumer_secret=self.s.x_consumer_secret,
                access_token=self.s.x_access_token,
                access_token_secret=self.s.x_access_token_secret,
            )

    def list_incoming(self) -> list[Message]:
        out: list[Message] = []
        out.extend(self._mentions())
        out.extend(self._dms())
        return out

    def _users_map(self, resp) -> dict:
        users = (resp.includes or {}).get("users", []) if resp.includes else []
        return {u.id: u for u in users}

    def _mentions(self) -> list[Message]:
        resp = self.client.get_users_mentions(
            self.s.x_user_id, expansions="author_id",
            tweet_fields="created_at,conversation_id")
        users = self._users_map(resp)
        out = []
        for tw in resp.data or []:
            u = users.get(tw.author_id)
            out.append(self._to_message(
                mid=tw.id, text=tw.text, thread=str(tw.conversation_id or tw.id),
                created=tw.created_at, user=u, kind="mention"))
        return out

    def _dms(self) -> list[Message]:
        # DMs require user context (OAuth1) in real mode; bearer in mock mode
        resp = self.client.get_direct_message_events(
            expansions="sender_id", user_auth=not self.s.is_mock,
            dm_event_fields="created_at,sender_id,dm_conversation_id")
        users = self._users_map(resp)
        out = []
        for ev in resp.data or []:
            u = users.get(ev.sender_id)
            out.append(self._to_message(
                mid=ev.id, text=getattr(ev, "text", ""),
                thread=str(getattr(ev, "dm_conversation_id", ev.id)),
                created=getattr(ev, "created_at", None), user=u, kind="dm"))
        return out

    def _to_message(self, mid, text, thread, created, user, kind) -> Message:
        handle = getattr(user, "username", None) or "unknown"
        name = getattr(user, "name", None) or handle
        ts = created if isinstance(created, datetime) else datetime.now(timezone.utc)
        sender = Participant(id=f"x:{handle}", name=name, handle=f"@{handle}")
        return Message(
            id=f"x:{mid}", channel=Channel.x, thread_id=thread, sender=sender,
            timestamp=ts, body=text, direction=Direction.incoming,
            subject=None,
            provenance={"provider": "x", "id": str(mid), "kind": kind})

    def send_reply(self, thread_id: str, text: str, to: str | None = None) -> dict:
        # user_auth=False in mock mode (no OAuth1 consumer creds); real mode supplies them
        resp = self.client.create_tweet(text=text, in_reply_to_tweet_id=thread_id,
                                        user_auth=not self.s.is_mock)
        return resp.data if hasattr(resp, "data") else {"data": resp}

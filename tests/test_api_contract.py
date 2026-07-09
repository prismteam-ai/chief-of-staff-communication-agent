"""Wire-contract tests: the mock's surface matches the real provider APIs, and the real
SDKs (in real mode) emit exactly those paths. This is what makes MODE=real trustworthy.
"""

import httpx
import pytest
import requests_mock
import respx


def test_mock_serves_every_real_api_route():
    """Each real provider path the SDKs call must be reachable on the mock (not 404)."""
    from fastapi.testclient import TestClient

    from cos.mocks.app import app
    c = TestClient(app)
    calls = [
        ("GET", "/gmail/v1/users/me/messages", None),
        ("GET", "/gmail/v1/users/me/messages/anyid", None),
        ("POST", "/gmail/v1/users/me/messages/send", {"raw": ""}),
        ("GET", "/2/users/123/mentions", None),
        ("GET", "/2/dm_events", None),
        ("POST", "/2/tweets", {"text": "hi"}),
        ("GET", "/v19.0/100/messages", None),
        ("POST", "/v19.0/100/messages", {"to": "1", "text": {"body": "x"}}),
        ("GET", "/api/1.0/tasks", None),
        ("GET", "/api/1.0/projects", None),
        ("GET", "/api/1.0/tasks/1202000000000001", None),
        ("POST", "/api/1.0/tasks", {"data": {"name": "t"}}),
        ("POST", "/api/1.0/tasks/1202000000000001/stories", {"data": {"text": "c"}}),
    ]
    for method, path, body in calls:
        r = c.request(method, path, json=body)
        assert r.status_code != 404, f"{method} {path} -> {r.status_code}"


@pytest.fixture()
def real_env(monkeypatch):
    from cos.config import get_settings
    monkeypatch.setenv("MODE", "real")
    monkeypatch.setenv("X_BASE_URL", "https://api.twitter.com")
    monkeypatch.setenv("WHATSAPP_BASE_URL", "https://graph.facebook.com")
    # real mode needs X OAuth1 user context to build the client
    monkeypatch.setenv("X_CONSUMER_KEY", "ck")
    monkeypatch.setenv("X_CONSUMER_SECRET", "cs")
    monkeypatch.setenv("X_ACCESS_TOKEN", "at")
    monkeypatch.setenv("X_ACCESS_TOKEN_SECRET", "ats")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_tweepy_hits_real_mentions_path(real_env):
    from cos.connectors.x import XConnector
    with requests_mock.Mocker() as mk:
        mk.get("https://api.twitter.com/2/users/1000000000000000001/mentions",
               json={"data": [], "meta": {"result_count": 0}})
        XConnector()._mentions()
        assert mk.last_request.path == "/2/users/1000000000000000001/mentions"
        assert "author_id" in mk.last_request.qs["expansions"][0]


def test_whatsapp_hits_real_cloud_api_path(real_env):
    # Real-mode inbound arrives via webhook (see cos.webhooks.whatsapp), not a poll — the
    # Cloud API has no list endpoint. The genuinely-real wire path is the send POST, which
    # must match /<version>/<phone_id>/messages on graph.facebook.com exactly.
    from cos.connectors.whatsapp import WhatsAppConnector
    with respx.mock:
        route = respx.post(url__regex=r"https://graph\.facebook\.com/.*/messages").mock(
            return_value=httpx.Response(200, json={"messages": [{"id": "wamid.x"}]}))
        WhatsAppConnector().send_reply("wa:15551234567", "hello")
        assert route.called
        url = str(route.calls.last.request.url)
        assert "/v19.0/" in url and url.endswith("/messages")

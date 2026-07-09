"""Real-mode wiring: credentials are built correctly and the WhatsApp webhook path
round-trips — all without touching a live provider API.
"""

import hashlib
import hmac
import json

import pytest


@pytest.fixture()
def real_settings(monkeypatch, tmp_path):
    from cos.config import get_settings

    monkeypatch.setenv("MODE", "real")
    monkeypatch.setenv("GMAIL_BASE_URL", "https://gmail.googleapis.com")
    monkeypatch.setenv("X_BASE_URL", "https://api.twitter.com")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "csecret")
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "rt-123")
    monkeypatch.setenv("X_CONSUMER_KEY", "ck")
    monkeypatch.setenv("X_CONSUMER_SECRET", "cs")
    monkeypatch.setenv("X_ACCESS_TOKEN", "at")
    monkeypatch.setenv("X_ACCESS_TOKEN_SECRET", "ats")
    monkeypatch.setenv("WHATSAPP_APP_SECRET", "shh")
    monkeypatch.setenv("WHATSAPP_VERIFY_TOKEN", "vtok")
    monkeypatch.setenv("WHATSAPP_INBOX_PATH", str(tmp_path / "inbox.json"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# --- Gmail --------------------------------------------------------------------
def test_gmail_real_uses_refresh_token(real_settings):
    from cos.connectors.gmail import GmailConnector

    creds = GmailConnector()._credentials()
    assert creds.refresh_token == "rt-123"
    assert creds.client_id == "cid"
    assert "gmail.send" in " ".join(creds.scopes)
    assert creds.token is None  # forces a refresh on first request


def test_gmail_real_requires_refresh_token(real_settings, monkeypatch):
    from cos.config import get_settings

    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "")
    get_settings.cache_clear()
    from cos.connectors.gmail import GmailConnector

    with pytest.raises(RuntimeError, match="GOOGLE_REFRESH_TOKEN"):
        GmailConnector()


# --- X ------------------------------------------------------------------------
def test_x_real_has_user_context_and_no_redirect(real_settings):
    from cos.connectors.x import XConnector, _REAL_HOST

    x = XConnector()
    assert x.client.consumer_key == "ck"
    assert x.client.access_token == "at"
    assert _REAL_HOST not in x.client.session.adapters  # no mock redirect in real mode


def test_x_real_requires_oauth1(real_settings, monkeypatch):
    from cos.config import get_settings

    monkeypatch.setenv("X_ACCESS_TOKEN", "")
    get_settings.cache_clear()
    from cos.connectors.x import XConnector

    with pytest.raises(RuntimeError, match="x_access_token"):
        XConnector()


# --- WhatsApp webhook + inbox -------------------------------------------------
def _signed(app_secret: str, body: dict) -> tuple[bytes, str]:
    raw = json.dumps(body).encode()
    sig = "sha256=" + hmac.new(app_secret.encode(), raw, hashlib.sha256).hexdigest()
    return raw, sig


def _delivery(wa_id="15551234567", text="hi there", mid="wamid.AA"):
    return {
        "entry": [{"changes": [{"value": {
            "contacts": [{"wa_id": wa_id, "profile": {"name": "Sarah"}}],
            "messages": [{"from": wa_id, "id": mid, "timestamp": "1700000000",
                          "type": "text", "text": {"body": text}}],
        }}]}]
    }


def test_whatsapp_webhook_verify_and_receive_and_drain(real_settings):
    from fastapi.testclient import TestClient
    from cos.webhooks.whatsapp import app
    from cos.connectors import whatsapp_inbox

    client = TestClient(app)

    # verification handshake echoes the challenge only on the right token
    ok = client.get("/webhooks/whatsapp", params={
        "hub.mode": "subscribe", "hub.verify_token": "vtok", "hub.challenge": "42"})
    assert ok.status_code == 200 and ok.text == "42"
    bad = client.get("/webhooks/whatsapp", params={
        "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42"})
    assert bad.status_code == 403

    body = _delivery()
    raw, sig = _signed("shh", body)

    # a bad signature is rejected
    assert client.post("/webhooks/whatsapp", content=raw,
                       headers={"X-Hub-Signature-256": "sha256=deadbeef",
                                "Content-Type": "application/json"}).status_code == 401

    # a valid delivery is buffered
    good = client.post("/webhooks/whatsapp", content=raw,
                       headers={"X-Hub-Signature-256": sig,
                                "Content-Type": "application/json"})
    assert good.status_code == 200 and good.json()["received"] == 1

    # the connector drains it into a normalized Message, and the buffer empties
    from cos.connectors.whatsapp import WhatsAppConnector
    msgs = WhatsAppConnector().list_incoming()
    assert len(msgs) == 1
    m = msgs[0]
    assert m.body == "hi there" and m.sender.name == "Sarah"
    assert m.channel.value == "whatsapp"
    assert whatsapp_inbox.read()["messages"] == []  # drained
    assert WhatsAppConnector().list_incoming() == []  # ingested once

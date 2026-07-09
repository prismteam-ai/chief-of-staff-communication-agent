"""The MODE switch must flip every seam (base URLs, tweepy redirect, embedder) correctly."""

import pytest


@pytest.fixture()
def real_env(monkeypatch):
    from cos.config import get_settings
    monkeypatch.setenv("MODE", "real")
    monkeypatch.setenv("X_BASE_URL", "https://api.twitter.com")
    monkeypatch.setenv("GMAIL_BASE_URL", "https://gmail.googleapis.com")
    # real mode requires user-context creds; dummy values are enough to construct clients
    monkeypatch.setenv("X_CONSUMER_KEY", "ck")
    monkeypatch.setenv("X_CONSUMER_SECRET", "cs")
    monkeypatch.setenv("X_ACCESS_TOKEN", "at")
    monkeypatch.setenv("X_ACCESS_TOKEN_SECRET", "ats")
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "rt")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "csecret")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_mock_mode_defaults(mock_server):
    from cos.config import get_settings
    s = get_settings()
    assert s.is_mock
    assert "127.0.0.1" in s.x_base_url


def test_mock_mode_mounts_tweepy_redirect(mock_server):
    from cos.connectors.x import XConnector
    x = XConnector()
    assert "https://api.twitter.com" in x.client.session.adapters   # redirect installed


def test_real_mode_no_redirect_and_real_hosts(real_env):
    from cos.config import get_settings
    from cos.connectors.x import XConnector
    s = get_settings()
    assert not s.is_mock
    assert s.x_base_url == "https://api.twitter.com"
    x = XConnector()
    assert "https://api.twitter.com" not in x.client.session.adapters  # no redirect


def test_embedder_selected_by_mode(mock_server, monkeypatch):
    from cos.kb import embeddings
    from cos.kb.embeddings import LocalEmbedding, get_embedder
    assert isinstance(get_embedder(), LocalEmbedding)     # mock -> local, keyless

    # real -> OpenAI branch (stub the class so we don't need the openai package/key)
    from cos.config import get_settings
    sentinel = object()
    monkeypatch.setattr(embeddings, "OpenAIEmbedding", lambda: sentinel)
    monkeypatch.setenv("MODE", "real")
    get_settings.cache_clear()
    try:
        assert get_embedder() is sentinel
    finally:
        get_settings.cache_clear()

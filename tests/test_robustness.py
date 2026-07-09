"""Connector mapping must survive malformed / weird provider payloads.

Real Gmail/X responses are messier than fixtures: missing headers, bad base64, missing
expansion users, unicode. These map the raw payloads directly (no server) and assert the
connector produces a Message without crashing.
"""

from cos.connectors.gmail import GmailConnector
from cos.connectors.x import XConnector
from cos.config import get_settings


def _gmail():
    g = object.__new__(GmailConnector)
    g.s = get_settings()
    return g


def test_gmail_missing_headers():
    m = _gmail()._to_message(
        {"id": "1", "threadId": "t", "internalDate": "0", "payload": {"headers": [], "body": {}}})
    assert m.channel.value == "gmail" and m.body == ""


def test_gmail_missing_payload():
    m = _gmail()._to_message(
        {"id": "2", "threadId": "t", "internalDate": "1700000000000", "snippet": "hi"})
    assert m.body == "hi"


def test_gmail_bad_base64_falls_back_to_snippet():
    # "A" is invalid base64 (bad padding) and reliably raises -> snippet fallback
    m = _gmail()._to_message({
        "id": "3", "threadId": "t", "internalDate": "0", "snippet": "fallback text",
        "payload": {"headers": [{"name": "From", "value": "A <a@b.c>"}],
                    "body": {"data": "A"}}})
    assert m.body == "fallback text"          # did not crash; used snippet


def test_gmail_garbage_base64_never_crashes():
    # some malformed base64 partial-decodes rather than raising; must still return a str
    for junk in ("!!!not-valid!!!", "###", "\x00\x01", "-_-_"):
        m = _gmail()._to_message({
            "id": "9", "threadId": "t", "internalDate": "0", "snippet": "s",
            "payload": {"headers": [], "body": {"data": junk}}})
        assert isinstance(m.body, str)


def test_gmail_unicode_headers():
    m = _gmail()._to_message({
        "id": "4", "threadId": "t", "internalDate": "0",
        "payload": {"headers": [{"name": "From", "value": "Zoë <z@y.z>"},
                                {"name": "Subject", "value": "café ☕ 日本語"}],
                    "body": {"data": ""}}})
    assert m.subject == "café ☕ 日本語" and m.sender.email == "z@y.z"


def test_x_mapping_missing_user():
    x = object.__new__(XConnector)
    # user=None (expansion not returned) must not crash
    msg = x._to_message(mid="9", text="hello", thread="18", created=None,
                        user=None, kind="mention")
    assert msg.channel.value == "x" and msg.sender.handle == "@unknown"

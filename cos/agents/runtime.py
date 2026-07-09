"""Shared, lazily-built runtime singletons (KB + Asana) for the agents/tools."""

from __future__ import annotations

_KB = None
_ASANA = None
_CONNECTORS: dict | None = None


def get_kb():
    global _KB
    if _KB is None:
        from cos.kb.build import build_kb
        _KB = build_kb()
    return _KB


def get_asana():
    global _ASANA
    if _ASANA is None:
        from cos.asana_client import AsanaClient
        _ASANA = AsanaClient()
    return _ASANA


def get_connectors() -> dict:
    """Channel connectors keyed by channel name (gmail/x/whatsapp)."""
    global _CONNECTORS
    if _CONNECTORS is None:
        from cos.connectors import all_connectors
        _CONNECTORS = {c.name: c for c in all_connectors()}
    return _CONNECTORS


def reset() -> None:
    global _KB, _ASANA, _CONNECTORS
    _KB = _ASANA = _CONNECTORS = None

"""Channel connectors. Each wraps the real provider SDK behind a common interface."""

from cos.connectors.base import Connector
from cos.connectors.gmail import GmailConnector
from cos.connectors.whatsapp import WhatsAppConnector
from cos.connectors.x import XConnector


def all_connectors() -> list[Connector]:
    """The active connector set. Adding a channel = implementing Connector and
    appending it here — nothing else in the system changes.

    A channel that fails to initialize (e.g. switched to real mode without credentials)
    is skipped, not fatal — the other channels keep working."""
    out: list[Connector] = []
    for factory in (GmailConnector, XConnector, WhatsAppConnector):
        try:
            out.append(factory())
        except Exception:  # noqa: BLE001 — a misconfigured channel must not kill the rest
            continue
    return out


__all__ = ["Connector", "GmailConnector", "XConnector", "WhatsAppConnector",
           "all_connectors"]

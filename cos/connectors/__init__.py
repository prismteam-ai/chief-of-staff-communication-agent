"""Channel connectors. Each wraps the real provider SDK behind a common interface."""

from cos.connectors.base import Connector
from cos.connectors.gmail import GmailConnector
from cos.connectors.whatsapp import WhatsAppConnector
from cos.connectors.x import XConnector


def all_connectors() -> list[Connector]:
    """The active connector set. Adding a channel = implementing Connector and
    appending it here — nothing else in the system changes."""
    return [GmailConnector(), XConnector(), WhatsAppConnector()]


__all__ = ["Connector", "GmailConnector", "XConnector", "WhatsAppConnector",
           "all_connectors"]

"""The connector contract.

A channel is added to the Chief of Staff by implementing this one interface and
registering it in ``cos.connectors.all_connectors``. Nothing else in the system needs to
change — this is the "modular connector architecture" the assignment asks for.
"""

from __future__ import annotations

import abc

from cos.models import Channel, Message


class Connector(abc.ABC):
    #: which channel this connector serves
    channel: Channel

    @property
    def name(self) -> str:
        return self.channel.value

    @abc.abstractmethod
    def list_incoming(self) -> list[Message]:
        """Fetch messages from the provider and return them normalized."""

    @abc.abstractmethod
    def send_reply(self, thread_id: str, text: str, to: str | None = None) -> dict:
        """Send a reply on this channel. Returns the provider's send result."""

"""In-memory store the mock servers read from and mutate.

Loads the generated fixtures once, then serves them. Writes (sent replies, created
tasks) mutate the in-memory copy so a demo session stays consistent. Restarting the
server resets to the fixtures.
"""

from __future__ import annotations

import copy
import itertools

from cos.fixtures import load


class Store:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.gmail = copy.deepcopy(load("gmail.json"))
        self.x = copy.deepcopy(load("x.json"))
        self.whatsapp = copy.deepcopy(load("whatsapp.json"))
        self.asana = copy.deepcopy(load("asana.json"))
        self._ids = itertools.count(1)

    def next_id(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids):06d}"


store = Store()

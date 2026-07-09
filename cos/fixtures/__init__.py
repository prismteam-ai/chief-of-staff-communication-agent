"""Fixture generation + loading helpers."""

import json
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def load(name: str) -> dict | list:
    with open(DATA_DIR / name) as fh:
        return json.load(fh)

"""Seed / upload the dataset.

Regenerates the fixtures (the provider-native data the mock serves), and if a mock server
is running, resets it so it reloads the fresh data. This is the "upload data" step — run it
before starting the UI, or any time you change the scenario generator.

Run: ``python -m cos.scripts.seed``
"""

from __future__ import annotations

import httpx

from cos.config import get_settings
from cos.fixtures.generate import main as regenerate


def main() -> None:
    print("Regenerating fixtures...")
    regenerate()

    s = get_settings()
    base = f"http://{s.mock_host}:{s.mock_port}"
    try:
        httpx.post(f"{base}/_reset", timeout=2)
        print(f"Reloaded running mock at {base}")
    except Exception:
        print(f"(No running mock at {base} — it will load the new data on next start.)")


if __name__ == "__main__":
    main()

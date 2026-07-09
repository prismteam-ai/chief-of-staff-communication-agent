"""Shared test fixtures.

``mock_server`` runs the FastAPI provider mocks in a background thread on a dedicated
port and points every connector's base URL at it, so connector tests exercise the real
SDKs against the real HTTP mock (not stubs).
"""

from __future__ import annotations

import os
import threading
import time

import httpx
import pytest
import uvicorn

PORT = 8911
BASE = f"http://127.0.0.1:{PORT}"


class _Server(uvicorn.Server):
    def install_signal_handlers(self) -> None:  # don't hijack signals in a thread
        pass


@pytest.fixture(scope="session")
def mock_server():
    os.environ.update({
        "MODE": "mock",
        "GMAIL_BASE_URL": BASE, "X_BASE_URL": BASE,
        "WHATSAPP_BASE_URL": BASE, "ASANA_BASE_URL": f"{BASE}/api/1.0",
    })
    from cos.config import get_settings
    get_settings.cache_clear()

    config = uvicorn.Config("cos.mocks.app:app", host="127.0.0.1", port=PORT,
                            log_level="warning")
    server = _Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(50):
        try:
            httpx.get(f"{BASE}/", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("mock server did not start")
    yield BASE
    server.should_exit = True
    thread.join(timeout=5)

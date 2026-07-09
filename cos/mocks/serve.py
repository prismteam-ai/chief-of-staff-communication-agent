"""Run the provider mocks in a background thread.

Used by both the eval harness and the test suite so neither needs a hand-started server.
"""

from __future__ import annotations

import contextlib
import threading
import time

import httpx
import uvicorn


class _Server(uvicorn.Server):
    def install_signal_handlers(self) -> None:  # safe to run off the main thread
        pass


@contextlib.contextmanager
def run_mock(host: str = "127.0.0.1", port: int = 8900):
    """Start cos.mocks.app in a thread; yield the base URL; shut it down on exit."""
    base = f"http://{host}:{port}"
    config = uvicorn.Config("cos.mocks.app:app", host=host, port=port,
                            log_level="warning")
    server = _Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(60):
        try:
            httpx.get(f"{base}/", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("mock server did not start")
    try:
        yield base
    finally:
        server.should_exit = True
        thread.join(timeout=5)

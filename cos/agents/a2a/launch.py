"""Run the A2A role agents.

- `role_agents()` — a context manager that starts all role agents in background threads
  (used by the eval harness, the UI, and tests).
- `python -m cos.agents.a2a.launch <role>` — run a single role agent in the foreground
  (used by the docker-compose services).
"""

from __future__ import annotations

import contextlib
import sys
import threading
import time

import httpx
import uvicorn

from cos.agents.a2a.cards import ROLE_PORTS
from cos.agents.a2a.server import build_agent_app


class _Server(uvicorn.Server):
    def install_signal_handlers(self) -> None:
        pass


@contextlib.contextmanager
def role_agents(roles: list[str] | None = None, host: str = "127.0.0.1"):
    roles = roles or list(ROLE_PORTS)
    servers, threads = [], []
    for role in roles:
        port = ROLE_PORTS[role]
        app = build_agent_app(role, public_url=f"http://{host}:{port}")
        server = _Server(uvicorn.Config(app, host=host, port=port, log_level="warning"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        servers.append(server)
        threads.append(thread)
    for role in roles:  # wait until each card is reachable
        base = f"http://{host}:{ROLE_PORTS[role]}"
        for _ in range(60):
            try:
                httpx.get(f"{base}/.well-known/agent-card.json", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
    try:
        yield
    finally:
        for s in servers:
            s.should_exit = True
        for t in threads:
            t.join(timeout=5)


def main() -> None:
    role = sys.argv[1] if len(sys.argv) > 1 else "engineering"
    port = ROLE_PORTS[role]
    app = build_agent_app(role, public_url=f"http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()

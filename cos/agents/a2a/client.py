"""A2A client: discover a role agent via its card and send it a task.

`install()` wires this as the brain's delegator, so DELEGATE/ESCALATE/FORWARD/SCHEDULE actions
become real agent-to-agent HTTP calls to the right role agent.
"""

from __future__ import annotations

import os

import httpx

from cos.agents.a2a.cards import ROLE_PORTS


def role_url(role: str) -> str | None:
    env = os.environ.get(f"A2A_{role.upper()}_URL")
    if env:
        return env
    port = ROLE_PORTS.get(role)
    return f"http://127.0.0.1:{port}" if port else None


def fetch_card(base: str) -> dict:
    return httpx.get(f"{base}/.well-known/agent-card.json", timeout=5).json()


def send(base: str, text: str) -> str:
    req = {"jsonrpc": "2.0", "id": "1", "method": "message/send",
           "params": {"message": {"role": "user", "parts": [{"type": "text", "text": text}]}}}
    r = httpx.post(base, json=req, timeout=60).json()
    if r.get("error"):
        raise RuntimeError(r["error"].get("message", "a2a error"))
    return r["result"]["messages"][-1]["parts"][0]["text"]


def delegate(role: str, message, deleg):
    """Brain delegator hook — real A2A round-trip to the role agent."""
    base = role_url(role)
    if not base:
        deleg.status = "no-agent"
        return deleg
    try:
        card = fetch_card(base)                       # A2A discovery
        reply = send(base, f"{deleg.summary}\n\nOriginal message: {message.body}")
        deleg.status = "completed"
        deleg.response = f"[{card['name']}] {reply}"
    except Exception as e:  # noqa: BLE001
        deleg.status = "error"
        deleg.response = str(e)
    return deleg


def install() -> None:
    from cos.agents import brain
    brain.set_delegator(delegate)

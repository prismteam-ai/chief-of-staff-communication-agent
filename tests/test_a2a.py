"""A2A protocol tests — LLM mocked so they run keyless.

Covers the agent card, the JSON-RPC message/send contract, error handling, and a real
threaded round-trip through the client + brain delegator.
"""

import pytest
from fastapi.testclient import TestClient

from cos.agents.a2a import server


@pytest.fixture(autouse=True)
def mock_role_llm(monkeypatch):
    # replace the role agent's LLM with a canned handler
    monkeypatch.setattr(server, "_handle",
                        lambda role, text: f"[{role}] handled: {text[:30]}")


def test_agent_card_served():
    app = server.build_agent_app("engineering", public_url="http://x:8901")
    card = TestClient(app).get("/.well-known/agent-card.json").json()
    assert card["name"] == "engineering" and card["skills"]
    assert card["url"] == "http://x:8901"


def test_message_send_returns_completed_task():
    app = server.build_agent_app("cfo")
    body = {"jsonrpc": "2.0", "id": "7", "method": "message/send",
            "params": {"message": {"role": "user",
                                   "parts": [{"type": "text", "text": "tax question"}]}}}
    r = TestClient(app).post("/", json=body).json()
    assert r["id"] == "7"
    assert r["result"]["status"]["state"] == "completed"
    assert "[cfo] handled" in r["result"]["messages"][-1]["parts"][0]["text"]


def test_unknown_method_errors():
    app = server.build_agent_app("cfo")
    r = TestClient(app).post("/", json={"jsonrpc": "2.0", "id": 1,
                                        "method": "tasks/cancel", "params": {}}).json()
    assert r["error"]["code"] == -32601


def test_client_and_delegator_round_trip():
    from cos.agents.a2a import client
    from cos.agents.a2a.launch import role_agents
    from cos.agents.contracts import Delegation
    from cos.models import Channel, Direction, Message, Participant
    from datetime import datetime, timezone

    with role_agents(["engineering"]):
        card = client.fetch_card("http://127.0.0.1:8901")
        assert card["name"] == "engineering"
        reply = client.send("http://127.0.0.1:8901", "outage!")
        assert reply.startswith("[engineering] handled")

        m = Message(id="m", channel=Channel.whatsapp, thread_id="t",
                    sender=Participant(id="p", name="Dana Fox"),
                    timestamp=datetime.now(timezone.utc), body="API down",
                    direction=Direction.incoming)
        d = client.delegate("engineering", m, Delegation(role="engineering", summary="fix it"))
        assert d.status == "completed" and "[engineering]" in d.response

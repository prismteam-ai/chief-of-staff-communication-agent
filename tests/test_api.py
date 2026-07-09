"""App API: auth boundary, inbox/context, the SSE agent stream, approval send, connections.

The LLM is mocked (keyless) exactly as in test_agents, so the brain stream runs in CI.
"""

import json

import pytest
from fastapi.testclient import TestClient

from cos.agents.contracts import StyleProfile, Triage
from cos.kb.ontology import Action, AsanaOp, Draft, Priority, Recommendation


def _fake_structured(schema, **kw):
    class _R:
        def invoke(self, prompt):
            if schema is Triage:
                return Triage(priority=Priority.high, needs_reply=True)
            if schema is Recommendation:
                return Recommendation(message_id="x", action=Action.REPLY,
                                      asana_op=AsanaOp.UPDATE_TASK, priority=Priority.high,
                                      rationale="on it")
            if schema is Draft:
                return Draft(message_id="x", text="Thanks, on it. Will revert shortly.")
            raise AssertionError(schema)
    return _R()


@pytest.fixture()
def client(mock_server, monkeypatch):
    from cos.agents import brain, style
    from cos.api import app as api
    from cos.mocks.store import store
    store.reset()
    monkeypatch.setattr(brain, "structured", _fake_structured)
    monkeypatch.setattr(style, "owner_style_profile",
                        lambda kb: StyleProfile(tone="warm", formality="neutral",
                                                signoff="Dmitrii"))
    brain._APP = None
    monkeypatch.setattr(brain, "_DELEGATOR", None)
    api.rebuild_kb()
    return TestClient(api.app)


def _auth(role="viewer", username="demo"):
    from cos.api.auth import make_token
    return {"Authorization": f"Bearer {make_token(username, role)}"}


def _events(resp) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in resp.text.splitlines()
            if line.startswith("data: ")]


# ---- auth -------------------------------------------------------------------
def test_requires_auth(client):
    assert client.get("/api/messages").status_code == 401
    assert client.get("/api/messages", headers=_auth()).status_code == 200


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["mode"] == "mock"


# ---- inbox + context --------------------------------------------------------
def test_messages_and_context(client):
    r = client.get("/api/messages", headers=_auth())
    body = r.json()
    assert body["count"] > 0
    m = body["messages"][0]
    assert {"id", "channel", "sender", "snippet", "awaiting"} <= set(m)

    ctx = client.get(f"/api/messages/{m['id']}/context", headers=_auth())
    assert ctx.status_code == 200
    pack = ctx.json()
    assert "facts" in pack and "related_tasks" in pack and "cross_channel" in pack


# ---- agent stream -----------------------------------------------------------
def test_agent_stream_event_order(client):
    from cos.agents.runtime import get_kb
    from cos.eval import ground_truth as gt
    mid = next(c.trigger.id for c in gt.cases(get_kb()) if c.key == "sarah-series-a")
    r = client.post("/api/agent/stream", headers=_auth(), json={"message_id": mid})
    assert r.status_code == 200
    evs = _events(r)
    types = [e["type"] for e in evs]
    assert types[0] == "tool_call"                 # rag.context_pack first
    assert "context" in types and "thought" in types
    assert "action" in types and "draft" in types
    assert types[-1] == "result"
    result = evs[-1]["result"]
    assert result["recommendation"]["action"] == "REPLY"
    assert result["draft"]["text"]


# ---- approval gate (owner-only send) ---------------------------------------
def test_approve_requires_owner(client):
    body = {"message_id": "x", "channel": "whatsapp", "text": "hi",
            "thread_id": "wa:1", "to": "15551230000"}
    assert client.post("/api/approve", headers=_auth("viewer"), json=body).status_code == 403


def test_approve_owner_sends(client):
    from cos.mocks.store import store
    before = len(store.whatsapp["sent"])
    body = {"message_id": "x", "channel": "whatsapp", "text": "Thanks, on it.",
            "thread_id": "wa:15551230000", "to": "15551230000"}
    r = client.post("/api/approve", headers=_auth("owner"), json=body)
    assert r.status_code == 200 and r.json()["answered"] is True
    assert len(store.whatsapp["sent"]) == before + 1     # really sent via the mock


# ---- connections ------------------------------------------------------------
def test_connections_mock_all_connected(client):
    r = client.get("/api/connections", headers=_auth())
    body = r.json()
    assert body["mode"] == "mock"
    assert {p["provider"] for p in body["providers"]} == {"gmail", "whatsapp", "x", "asana"}
    assert all(p["connected"] and p["detail"] == "mock" for p in body["providers"])


def test_connections_update_requires_owner(client):
    assert client.post("/api/connections/gmail", headers=_auth("viewer"),
                       json={"mode": "mock"}).status_code == 403
    r = client.post("/api/connections/gmail", headers=_auth("owner"),
                    json={"mode": "mock"})
    assert r.status_code == 200 and r.json()["connected"] is True

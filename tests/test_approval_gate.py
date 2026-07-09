"""The approval gate is the product's safety core (CLAUDE.md: Do NOT regress).
These tests attack it at both layers against the live store, plus the multi-tenant
isolation invariant (a draft may only be sent by its owning tenant).

The send dispatch is stubbed (no real provider hit) — these tests exercise the
GATE and the OWNER SCOPING, not delivery. Real delivery is proven separately
against a demo account with the approval step observed (CLAUDE.md: Send gate)."""
import uuid
from datetime import datetime, timezone

import pytest

import cos_agent.ingest as ingest_mod
import cos_agent.send as send_mod
from cos_agent.connectors.base import RawMessage
from cos_agent.db import sb
from cos_agent.send import ApprovalRequired, send_draft


class _StubConnector:
    channel = "gmail"

    def send(self, to, body, thread_external_id):
        return f"stub-{uuid.uuid4().hex[:8]}"

    def fetch(self):
        yield RawMessage(
            channel="gmail", account_handle="stub@test", external_id="stub-ext-1",
            external_thread_id="stub-thr", direction="inbound",
            sender={"handle": "a@b.co", "display_name": "A"}, recipients=[],
            body_text="hi", sent_at=datetime.now(timezone.utc), raw_ref="test",
        )


@pytest.fixture()
def inbound_msg():
    """A real pending inbound message + its owner (any tenant with data)."""
    return (
        sb().table("messages").select("id, owner_id")
        .eq("direction", "inbound").eq("answered_status", "pending").limit(1).execute()
    ).data[0]


@pytest.fixture()
def unapproved_draft(inbound_msg):
    owner = inbound_msg["owner_id"]
    d = sb().table("drafts").insert(
        {"owner_id": owner, "message_id": inbound_msg["id"],
         "body": f"test draft {uuid.uuid4().hex[:6]}", "model": "test"}
    ).execute().data[0]
    yield d, owner
    sb().table("approvals").delete().eq("draft_id", d["id"]).execute()
    sb().table("drafts").delete().eq("id", d["id"]).execute()


def test_send_refuses_without_approval(unapproved_draft):
    d, owner = unapproved_draft
    with pytest.raises(ApprovalRequired):
        send_draft(d["id"], owner)


def test_send_refuses_cross_tenant(unapproved_draft):
    """Isolation: a draft cannot be sent by a different tenant, even if approved
    under its real owner. The owner-scoped lookup makes it a not-found miss."""
    d, owner = unapproved_draft
    sb().table("approvals").upsert(
        {"owner_id": owner, "draft_id": d["id"], "decision": "approved", "decided_by": "pytest"},
        on_conflict="draft_id",
    ).execute()
    other_tenant = str(uuid.uuid4())
    with pytest.raises(ApprovalRequired):
        send_draft(d["id"], other_tenant)
    # and it must not have been marked sent
    row = sb().table("drafts").select("status").eq("id", d["id"]).single().execute().data
    assert row["status"] != "sent"


def test_db_trigger_blocks_direct_sent_update(unapproved_draft):
    d, _ = unapproved_draft
    with pytest.raises(Exception) as exc:
        sb().table("drafts").update({"status": "sent"}).eq("id", d["id"]).execute()
    assert "approval gate" in str(exc.value)


def test_approved_draft_sends_and_persists_provider_id(unapproved_draft, monkeypatch):
    """Full happy path: approve -> send -> provider_message_id persisted + message
    answered. Exercises the exact write (drafts.provider_message_id) whose missing
    column silently 500'd every real approval until a migration was reapplied."""
    d, owner = unapproved_draft
    monkeypatch.setattr(send_mod, "connector_for", lambda o, ch: _StubConnector())
    sb().table("approvals").upsert(
        {"owner_id": owner, "draft_id": d["id"], "decision": "approved", "decided_by": "pytest"},
        on_conflict="draft_id",
    ).execute()
    result = send_draft(d["id"], owner)
    assert result.get("provider_message_id"), "send must return a provider message id"

    row = sb().table("drafts").select("status, provider_message_id").eq("id", d["id"]).single().execute().data
    assert row["status"] == "sent"
    assert row["provider_message_id"] == result["provider_message_id"], "provider id must persist"

    msg = sb().table("messages").select("answered_status").eq("id", d["message_id"]).single().execute().data
    assert msg["answered_status"] == "answered", "sending must mark the message answered"

    # restore the borrowed message so the demo store stays pending
    sb().table("messages").update({"answered_status": "pending", "answered_at": None}).eq("id", d["message_id"]).execute()


def test_ingest_is_idempotent(monkeypatch, inbound_msg):
    """Re-ingesting the same connector output must not duplicate (owner-scoped upsert)."""
    owner = inbound_msg["owner_id"]
    monkeypatch.setattr(ingest_mod, "connectors_for_owner", lambda o: [_StubConnector()])
    ingest_mod.ingest_for_owner(owner)
    r2 = ingest_mod.ingest_for_owner(owner)
    assert r2["channels"]["gmail"]["new"] == 0, "re-ingest must not create new rows"

    # cleanup: remove the stub message/thread/account for this owner
    sb().table("messages").delete().eq("owner_id", owner).eq("external_id", "stub-ext-1").execute()
    thr = sb().table("threads").select("id").eq("owner_id", owner).eq("external_thread_id", "stub-thr").execute().data
    for t in thr:
        sb().table("threads").delete().eq("id", t["id"]).execute()
    sb().table("accounts").delete().eq("owner_id", owner).eq("handle", "stub@test").execute()

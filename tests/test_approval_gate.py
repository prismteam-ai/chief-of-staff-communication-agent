"""The approval gate is the product's safety core (CLAUDE.md: Do NOT regress).
These tests attack it at both layers against the live store."""
import uuid

import pytest

from cos_agent import boot  # noqa: F401  (registers connectors)
from cos_agent.db import sb
from cos_agent.send import ApprovalRequired, send_draft


@pytest.fixture()
def unapproved_draft():
    msg = (
        sb().table("messages").select("id").eq("direction", "inbound").limit(1).execute()
    ).data[0]
    d = sb().table("drafts").insert(
        {"message_id": msg["id"], "body": f"test draft {uuid.uuid4().hex[:6]}", "model": "test"}
    ).execute().data[0]
    yield d
    sb().table("drafts").delete().eq("id", d["id"]).execute()


def test_send_refuses_without_approval(unapproved_draft):
    with pytest.raises(ApprovalRequired):
        send_draft(unapproved_draft["id"])


def test_db_trigger_blocks_direct_sent_update(unapproved_draft):
    with pytest.raises(Exception) as exc:
        sb().table("drafts").update({"status": "sent"}).eq("id", unapproved_draft["id"]).execute()
    assert "approval gate" in str(exc.value)


def test_approved_draft_sends_and_persists_provider_id(unapproved_draft):
    """Full happy path: approve -> send -> provider_message_id persisted + message
    answered. Exercises the exact write (drafts.provider_message_id) whose missing
    column silently 500'd every real approval until a migration was reapplied."""
    d = unapproved_draft
    sb().table("approvals").upsert(
        {"draft_id": d["id"], "decision": "approved", "decided_by": "pytest"},
        on_conflict="draft_id",
    ).execute()
    result = send_draft(d["id"])
    assert result.get("provider_message_id"), "send must return a provider message id"

    row = sb().table("drafts").select("status, provider_message_id").eq("id", d["id"]).single().execute().data
    assert row["status"] == "sent"
    assert row["provider_message_id"] == result["provider_message_id"], "provider id must persist"

    msg = sb().table("messages").select("answered_status").eq("id", d["message_id"]).single().execute().data
    assert msg["answered_status"] == "answered", "sending must mark the message answered"
    sb().table("approvals").delete().eq("draft_id", d["id"]).execute()


def test_ingest_is_idempotent():
    from cos_agent.ingest import ingest_all

    before = len(sb().table("messages").select("id").execute().data)
    report = ingest_all()
    after = len(sb().table("messages").select("id").execute().data)
    assert after == before, "re-ingest must not duplicate messages"
    assert not report["errors"], f"connectors errored: {report['errors']}"

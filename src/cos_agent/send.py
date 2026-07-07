"""Send path — the ONLY way a draft leaves the system.

Order of operations is the safety core (CLAUDE.md: Do NOT regress):
1. approval row must exist and be 'approved' (also DB-enforced by trigger)
2. dispatch via the originating channel's connector
3. mark draft sent + message answered (stops the <5-min clock)
"""
from __future__ import annotations

from datetime import datetime, timezone

from .connectors.base import get
from .db import sb


class ApprovalRequired(Exception):
    pass


def send_draft(draft_id: str) -> dict:
    draft = sb().table("drafts").select("*").eq("id", draft_id).single().execute().data
    if draft["status"] == "sent":
        return {"draft_id": draft_id, "skipped": "already sent"}

    approval = (
        sb().table("approvals").select("decision").eq("draft_id", draft_id).execute()
    ).data
    if not approval or approval[0]["decision"] != "approved":
        raise ApprovalRequired(f"draft {draft_id} has no approval — refusing to send")

    msg = sb().table("messages").select("*").eq("id", draft["message_id"]).single().execute().data
    thread = sb().table("threads").select("external_thread_id").eq("id", msg["thread_id"]).single().execute().data

    conn = get(msg["channel"])
    provider_id = conn.send(
        to=[msg["sender"]], body=draft["body"], thread_external_id=thread["external_thread_id"]
    )

    now = datetime.now(timezone.utc).isoformat()
    sb().table("drafts").update({"status": "sent", "sent_at": now}).eq("id", draft_id).execute()
    sb().table("messages").update({"answered_status": "answered", "answered_at": now}).eq(
        "id", draft["message_id"]
    ).execute()
    return {"draft_id": draft_id, "provider_message_id": provider_id, "sent_at": now}

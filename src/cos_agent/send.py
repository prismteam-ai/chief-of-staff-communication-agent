"""Send path — the ONLY way a draft leaves the system.

Order of operations is the safety core (CLAUDE.md: Do NOT regress):
1. approval row must exist and be 'approved' (also DB-enforced by trigger)
2. dispatch via the originating channel's connector
3. mark draft sent + message answered (stops the <5-min clock)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from .connectors.base import get
from .db import sb

log = logging.getLogger(__name__)


class ApprovalRequired(Exception):
    pass


class AlreadySent(Exception):
    pass


def send_draft(draft_id: str) -> dict:
    draft = sb().table("drafts").select("*").eq("id", draft_id).single().execute().data

    approval = (
        sb().table("approvals").select("decision").eq("draft_id", draft_id).execute()
    ).data
    if not approval or approval[0]["decision"] != "approved":
        raise ApprovalRequired(f"draft {draft_id} has no approval — refusing to send")

    # optimistic claim BEFORE dispatch: only one caller can move approved->sent,
    # so a concurrent double-approve cannot double-send. The DB trigger still
    # enforces the approval row underneath.
    now = datetime.now(timezone.utc).isoformat()
    claimed = (
        sb().table("drafts").update({"status": "sent", "sent_at": now})
        .eq("id", draft_id).neq("status", "sent").execute()
    ).data
    if not claimed:
        return {"draft_id": draft_id, "skipped": "already sent"}

    msg = sb().table("messages").select("*").eq("id", draft["message_id"]).single().execute().data
    thread = sb().table("threads").select("external_thread_id").eq("id", msg["thread_id"]).single().execute().data

    try:
        conn = get(msg["channel"])
        provider_id = conn.send(
            to=[msg["sender"]], body=draft["body"], thread_external_id=thread["external_thread_id"]
        )
    except Exception:
        # dispatch failed: release the claim so the draft can be retried
        sb().table("drafts").update({"status": "approved", "sent_at": None}).eq("id", draft_id).execute()
        log.exception("send dispatch failed for draft %s (%s)", draft_id, msg["channel"])
        raise

    sb().table("drafts").update({"provider_message_id": provider_id}).eq("id", draft_id).execute()
    sb().table("messages").update({"answered_status": "answered", "answered_at": now}).eq(
        "id", draft["message_id"]
    ).execute()
    log.info("sent draft %s via %s as %s", draft_id, msg["channel"], provider_id)
    return {"draft_id": draft_id, "provider_message_id": provider_id, "sent_at": now}

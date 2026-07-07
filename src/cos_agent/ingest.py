"""Ingest: connector fetch → normalized store with provenance.

allSettled semantics: one failed connector never aborts a run; failures are
collected and reported loudly. Empty fetch from a registered connector is a
warning, not a quiet zero.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .connectors.base import RawMessage, all_connectors
from .db import sb


def _account_id(cache: dict, channel: str, handle: str) -> str:
    key = (channel, handle)
    if key in cache:
        return cache[key]
    res = sb().table("accounts").select("id").eq("channel", channel).eq("handle", handle).execute()
    if res.data:
        cache[key] = res.data[0]["id"]
    else:
        created = sb().table("accounts").insert(
            {"channel": channel, "handle": handle, "is_self": True}
        ).execute()
        cache[key] = created.data[0]["id"]
    return cache[key]


def _thread_id(cache: dict, account_id: str, msg: RawMessage) -> str:
    key = (account_id, msg.external_thread_id)
    if key in cache:
        return cache[key]
    res = (
        sb().table("threads").select("id")
        .eq("account_id", account_id).eq("external_thread_id", msg.external_thread_id)
        .execute()
    )
    if res.data:
        cache[key] = res.data[0]["id"]
    else:
        created = sb().table("threads").insert({
            "channel": msg.channel,
            "account_id": account_id,
            "external_thread_id": msg.external_thread_id,
            "subject": msg.subject,
            "last_message_at": msg.sent_at.isoformat(),
        }).execute()
        cache[key] = created.data[0]["id"]
    return cache[key]


def ingest_all() -> dict:
    """Run every registered connector. Returns per-channel counts + errors."""
    report: dict = {"channels": {}, "errors": {}}
    acc_cache: dict = {}
    thr_cache: dict = {}
    for conn in all_connectors():
        try:
            new, seen = 0, 0
            for msg in conn.fetch():
                account_id = _account_id(acc_cache, msg.channel, msg.account_handle)
                thread_id = _thread_id(thr_cache, account_id, msg)
                row = {
                    "thread_id": thread_id,
                    "account_id": account_id,
                    "channel": msg.channel,
                    "external_id": msg.external_id,
                    "direction": msg.direction,
                    "sender": msg.sender,
                    "recipients": msg.recipients,
                    "body_text": msg.body_text,
                    "attachments": msg.attachments,
                    "sent_at": msg.sent_at.isoformat(),
                    "source_id": f"{msg.channel}-connector",
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "raw_ref": msg.raw_ref,
                    # outbound history is style corpus, not a queue item
                    "answered_status": "pending" if msg.direction == "inbound" else "no_reply_needed",
                }
                res = (
                    sb().table("messages")
                    .upsert(row, on_conflict="account_id,external_id", ignore_duplicates=True)
                    .execute()
                )
                if res.data:
                    new += 1
                else:
                    seen += 1
            report["channels"][conn.channel] = {"new": new, "already_seen": seen}
            if new == 0 and seen == 0:
                report["errors"][conn.channel] = "connector returned zero messages (loud warning)"
        except Exception as e:  # allSettled: collect, keep going
            report["errors"][conn.channel] = f"{type(e).__name__}: {e}"
    return report

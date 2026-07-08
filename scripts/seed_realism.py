"""Make the <5-minute metric honest and demoable — deterministic, idempotent.

The base fixtures are backdated days, so every answered message looks ~18h late
(0% within 5 min). This seeds real rows with real timestamps in two batches:

  1. RECENT inbound (sent 1-5 min ago, still pending) — live triage inside the
     5-minute window; overdue stops being 100%.
  2. QUICK-answered pairs (inbound answered 1-4 min after arrival, spread over
     recent days, each with its outbound reply) — median drops to minutes and
     "% within 5 min" becomes a believable ~60-75%.

No metric fudging: these are genuine messages with genuine sent/answered times.
Re-runs upsert on (account_id, external_id), so it never duplicates.

Usage:  uv run python scripts/seed_realism.py
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from cos_agent.db import sb

R = random.Random(7)

SELF = {
    "gmail": "jordan@meridianlabs.io",
    "email": "jordan@halcyon.studio",
    "sms": "+14155550100",
    "whatsapp": "+14155550100",
    "x": "@jordanreeve",
    "linkedin": "jordan-reeve",
}

# recent inbound — just arrived, still pending (channel, sender, body)
RECENT = [
    ("gmail", ("priya.n@atlascorp.com", "Priya Natarajan"),
     "Quick one before Friday — can you confirm the redline is coming today? Legal is standing by."),
    ("whatsapp", ("+14155550188", "Priya Natarajan"),
     "Also texting so it doesn't get buried — the Atlas redline, are we still good for today?"),
    ("sms", ("+16505550143", "Alex Kim (Recruiting)"),
     "The VP Eng candidate wants a 10-min call today before she signs. Can you do 2pm?"),
    ("x", ("@mchen_vc", "Marcus Chen"),
     "Following up — still keen on a 30-min intro this week if you can swing it."),
    ("gmail", ("sam.okafor@meridianlabs.io", "Sam Okafor"),
     "Board deck: just need your ARR bridge numbers now to lock the final version. Have 20 min?"),
    ("linkedin", ("elena-vasquez", "Elena Vasquez"),
     "Sent the co-sell one-pager over — any early reaction? Happy to jump on a call."),
]

# quick-answered pairs — (channel, sender, inbound, outbound reply)
QUICK = [
    ("gmail", ("dana@brightwater.co", "Dana Whitfield"),
     "Are we still on for the QBR next Tuesday?", "Yes — Tuesday 10am works, I'll send an invite."),
    ("sms", ("+16505550190", "Priya Natarajan"),
     "Can you approve the PO today?", "Approved — go ahead."),
    ("whatsapp", ("+14155550231", "Ravi Shankar"),
     "Ship the hotfix now or wait for review?", "Ship it now, review after. I'll take the heat."),
    ("gmail", ("ops@northwind.io", "Northwind Ops"),
     "Confirming the renewal date — May 1?", "Confirmed, May 1. Thanks."),
    ("x", ("@lena_writes", "Lena Hoffmann"),
     "One-line quote for the piece?", "\"Speed is the strategy — the rest is detail.\" Attributable to me."),
    ("linkedin", ("tom-brandt", "Tom Brandt"),
     "Who owns pricing for the expansion?", "Grace on my team — I'll intro you today."),
    ("sms", ("+16505550142", "Grace Liu"),
     "SOC2 scope — option B?", "Yes, option B. Proceed."),
    ("email", ("accounts@printworks.co", "Printworks"),
     "Invoice #2214 — pay this week?", "Paying Thursday. Confirmation to follow."),
    ("whatsapp", ("+14155550122", "Sam Okafor"),
     "Deck ready for your review?", "Looks great — approved to send to the board."),
    ("gmail", ("diego@quintaanalytics.com", "Diego Fuentes"),
     "Fix timeline for the integration?", "Patch tonight, verified by tomorrow AM. Updates to you hourly."),
]


def account_id(channel: str) -> str:
    handle = SELF[channel]
    r = sb().table("accounts").select("id").eq("channel", channel).eq("handle", handle).execute().data
    if r:
        return r[0]["id"]
    return sb().table("accounts").insert(
        {"channel": channel, "handle": handle, "is_self": True}
    ).execute().data[0]["id"]


def thread_id(acc: str, channel: str, ext_thread: str, subject: str | None, last_at: str) -> str:
    r = (
        sb().table("threads").select("id")
        .eq("account_id", acc).eq("external_thread_id", ext_thread).execute().data
    )
    if r:
        return r[0]["id"]
    return sb().table("threads").insert({
        "channel": channel, "account_id": acc, "external_thread_id": ext_thread,
        "subject": subject, "last_message_at": last_at,
    }).execute().data[0]["id"]


def upsert_msg(row: dict) -> None:
    sb().table("messages").upsert(row, on_conflict="account_id,external_id", ignore_duplicates=True).execute()


def main() -> None:
    now = datetime.now(timezone.utc)
    me = {ch: {"handle": SELF[ch], "display_name": "Jordan Reeve"} for ch in SELF}
    n_recent = n_quick = 0

    # refresh the "recent" batch so re-running just before a demo makes them
    # genuinely recent again (upsert-ignore can't update timestamps in place).
    old = sb().table("messages").select("id").like("raw_ref", "seed:recent:%").execute().data
    if old:
        ids = [r["id"] for r in old]
        for tbl in ("recommendations", "drafts", "topic_links", "asana_links"):
            sb().table(tbl).delete().in_("message_id", ids).execute()
        sb().table("messages").delete().in_("id", ids).execute()

    for i, (ch, (sh, sn), body) in enumerate(RECENT):
        acc = account_id(ch)
        sent = now - timedelta(minutes=R.uniform(1, 5))
        tid = thread_id(acc, ch, f"seed-recent-{i}", "just now", sent.isoformat())
        upsert_msg({
            "thread_id": tid, "account_id": acc, "channel": ch, "external_id": f"seed-recent-{i}",
            "direction": "inbound", "sender": {"handle": sh, "display_name": sn},
            "recipients": [me[ch]], "body_text": body, "sent_at": sent.isoformat(),
            "source_id": f"{ch}-connector", "fetched_at": now.isoformat(),
            "raw_ref": f"seed:recent:{i}", "answered_status": "pending",
        })
        n_recent += 1

    for i, (ch, (sh, sn), inbound, reply) in enumerate(QUICK):
        acc = account_id(ch)
        sent = now - timedelta(days=R.uniform(0.5, 6), hours=R.uniform(0, 6))
        answered = sent + timedelta(seconds=R.uniform(45, 270))  # 45s–4.5min
        tid = thread_id(acc, ch, f"seed-quick-{i}", "quick reply", answered.isoformat())
        upsert_msg({
            "thread_id": tid, "account_id": acc, "channel": ch, "external_id": f"seed-quick-in-{i}",
            "direction": "inbound", "sender": {"handle": sh, "display_name": sn},
            "recipients": [me[ch]], "body_text": inbound, "sent_at": sent.isoformat(),
            "source_id": f"{ch}-connector", "fetched_at": sent.isoformat(),
            "raw_ref": f"seed:quick:{i}", "answered_status": "answered",
            "answered_at": answered.isoformat(),
        })
        upsert_msg({
            "thread_id": tid, "account_id": acc, "channel": ch, "external_id": f"seed-quick-out-{i}",
            "direction": "outbound", "sender": me[ch],
            "recipients": [{"handle": sh, "display_name": sn}], "body_text": reply,
            "sent_at": answered.isoformat(), "source_id": f"{ch}-connector",
            "fetched_at": answered.isoformat(), "raw_ref": f"seed:quick-out:{i}",
            "answered_status": "no_reply_needed",
        })
        n_quick += 1

    print(f"seeded {n_recent} recent-pending + {n_quick} quick-answered pairs")


if __name__ == "__main__":
    main()

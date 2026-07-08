"""Replace fixture-mode Asana links with REAL tasks — honesty over flash.

The brain created 48 Asana links during fixture-mode runs (task_gid `fx-…`, URLs
`app.asana.com/0/demo/…`). Now that a real Asana PAT is connected, showing those
as "live linked tasks" is fabrication (violates the anti-fabrication gate). This
deletes the fixture links + their RAG docs and creates a curated set of GENUINE
Asana tasks (real permalinks) for clearly-actionable demo communications.

Usage:  uv run python scripts/reconcile_asana.py
"""
from __future__ import annotations

from cos_agent.asana import client, task_from_message
from cos_agent.db import sb

# external_id -> (task title, detail). Only clearly-actionable comms get a task.
CURATED = {
    "gm-1001": ("Send Atlas FY27 redline before Friday",
                "Atlas renewal: 99.9% SLA + QBRs agreed; send the redline to Priya to close by Friday."),
    "em-6001": ("Pay Printworks invoice #2214 ($4,850)",
                "Spring campaign print run, 15 days overdue; confirm payment timing before the late fee."),
    "sms-3001": ("Send written VP Eng offer (L7) by Thursday",
                 "Candidate accepted verbally; send the formal offer at the approved band."),
    "x-4001": ("Schedule 30-min intro with Marcus Chen (VC)",
               "Applied-AI infra investor; interested after the Meridian launch thread."),
    "li-5001": ("Review Northbeam co-sell one-pager",
                "Elena Vasquez (Northbeam partnerships); shared customers; evaluate a co-sell motion."),
    "gm-1004": ("Confirm TechLedger interview slot (Tue/Wed PM)",
                "Dana Chen, enterprise-AI-adoption feature; 20 minutes next week."),
    "wa-2001": ("Unblock Atlas renewal before CFO travels Friday",
                "Priya (Atlas) following up on WhatsApp; CFO wants it wrapped before Friday."),
    # NOTE: never target ephemeral seed-recent-* here — seed_realism deletes and
    # recreates them on refresh, which would orphan the task link.
}


def main() -> None:
    if client().mode != "real":
        raise SystemExit("Asana is not in real mode (ASANA_ACCESS_TOKEN unset) — aborting.")

    # 1. purge fixture links + their RAG docs
    fx = [r for r in sb().table("asana_links").select("task_gid").execute().data
          if r["task_gid"].startswith("fx-")]
    for r in fx:
        sb().table("asana_links").delete().eq("task_gid", r["task_gid"]).execute()
        sb().table("rag_documents").delete().eq("source_type", "asana").eq("source_id", r["task_gid"]).execute()
    print(f"purged {len(fx)} fixture asana links + rag docs")

    # 2. create real tasks for curated actionable messages (idempotent: skip if a
    #    real link already exists for that message)
    created = 0
    for ext_id, (title, detail) in CURATED.items():
        msg = sb().table("messages").select("id").eq("external_id", ext_id).execute().data
        if not msg:
            print(f"  skip {ext_id}: not in store")
            continue
        mid = msg[0]["id"]
        existing = [r for r in sb().table("asana_links").select("task_gid").eq("message_id", mid).execute().data
                    if not r["task_gid"].startswith("fx-")]
        if existing:
            print(f"  skip {ext_id}: already has a real task")
            continue
        task = task_from_message(mid, title, detail)
        print(f"  created: {task.get('permalink_url')}")
        created += 1
    print(f"done — {created} real Asana tasks created")


if __name__ == "__main__":
    main()

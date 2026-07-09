"""Seed the demo tenant's inbox with REAL emails (not fixtures).

Sends genuine emails over SMTP from democos@zohomail.com (a real Zoho mailbox we
control; its app-password lives in connector_tokens) INTO chiefofstaff.demo@zohomail.com
(the demo tenant's connected IMAP account). These are real, delivered messages the demo
tenant then fetches over real IMAP — the honest replacement for the retired fixture corpus.

Single real external correspondent (one person, one real address) across several threads —
the triage/draft/task/needs-context variety comes from the CONTENT, not faked identities.
(CLAUDE.md: real or cut, never faked.)

Run once, after chiefofstaff.demo is connected + IMAP-enabled:
    uv run python scripts/seed_demo_inbox.py
"""
from __future__ import annotations

import json
import smtplib
import sys
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from cos_agent.db import sb

SENDER_HANDLE = "democos@zohomail.com"          # real mailbox we control (secret in DB)
SENDER_NAME = "Priya Nair"                       # one real external contact (client-side PM)
RECIPIENT = "chiefofstaff.demo@zohomail.com"     # the demo tenant's connected inbox

# Coherent client relationship; each email pushes the brain to a different action.
EMAILS = [
    {
        "subject": "Re-scheduling Thursday's kickoff",
        "body": (
            "Hi,\n\n"
            "Something came up on our side and I can't make the kickoff Thursday at 2pm. "
            "Could we push it to Friday morning, or early next week? Happy to work around "
            "your calendar — just let me know what's open.\n\n"
            "Thanks,\nPriya"
        ),
    },
    {
        "subject": "Question on invoice #4471",
        "body": (
            "Hello,\n\n"
            "Our finance team flagged invoice #4471 — the line item for the March discovery "
            "work looks like it was billed at the full rate rather than the discounted rate we "
            "agreed on. Could someone take a look and send a corrected copy? We'd like to get "
            "it paid this cycle.\n\n"
            "Best,\nPriya"
        ),
    },
    {
        "subject": "Scope change: adding the analytics dashboard",
        "body": (
            "Hi,\n\n"
            "Leadership wants to add a customer analytics dashboard to the current phase. I know "
            "that's beyond the original SOW — can you put together a rough estimate on timeline "
            "and cost so I can take it to our budget review next week? No need for a formal "
            "proposal yet, just a ballpark.\n\n"
            "Appreciate it,\nPriya"
        ),
    },
    {
        "subject": "Intro: our new data lead",
        "body": (
            "Hi,\n\n"
            "I'd like to introduce you to Marcus, who just joined as our data lead and will be "
            "your main technical contact going forward. I'll loop him in on the next thread. He "
            "may reach out with a few questions about the integration — treat anything from him "
            "as coming from me.\n\n"
            "Cheers,\nPriya"
        ),
    },
    {
        "subject": "URGENT: contract signature needed by EOD",
        "body": (
            "Hi,\n\n"
            "Sorry for the short notice — our legal team needs the signed renewal back by end of "
            "day today to keep the account active through Q3. Is there any chance you can get it "
            "over the line this afternoon? Let me know if anything's blocking it on your side.\n\n"
            "Thanks so much,\nPriya"
        ),
    },
]


def _smtp_cfg() -> dict:
    row = (
        sb().table("connector_tokens").select("refresh_token")
        .eq("channel", "email").eq("account_handle", SENDER_HANDLE).single().execute().data
    )
    if not row:
        sys.exit(f"no connector_tokens row for {SENDER_HANDLE} — cannot seed")
    cfg = json.loads(row["refresh_token"])
    imap_host = cfg.get("imap_host", "imap.zoho.com")
    return {
        "password": cfg["password"],
        "smtp_host": cfg.get("smtp_host") or imap_host.replace("imap", "smtp"),
        "smtp_port": int(cfg.get("smtp_port", 465)),
    }


def main() -> None:
    cfg = _smtp_cfg()
    sent = 0
    with smtplib.SMTP_SSL(cfg["smtp_host"], cfg["smtp_port"], timeout=30) as s:
        s.login(SENDER_HANDLE, cfg["password"])
        for e in EMAILS:
            em = EmailMessage()
            em["From"] = f"{SENDER_NAME} <{SENDER_HANDLE}>"
            em["To"] = RECIPIENT
            em["Subject"] = e["subject"]
            em["Date"] = formatdate(localtime=True)
            em["Message-ID"] = make_msgid(domain="zohomail.com")  # distinct thread each
            em.set_content(e["body"])
            s.send_message(em)
            sent += 1
            print(f"  sent → {e['subject']}")
            time.sleep(1)  # polite; keep distinct timestamps
    print(f"\ndone: {sent} real emails delivered to {RECIPIENT}")


if __name__ == "__main__":
    main()

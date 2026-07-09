"""Generate the "Series A closing week" scenario as provider-native fixtures.

Run: ``python -m cos.fixtures.generate``

The data has one narrative spine — the exec is closing their Series A — so priorities,
cross-channel chatter, and judgment calls feel real. Two layers:
  * 16 curated, LABELED scenarios (each with the expected communication action + Asana op),
    including cross-channel threads and every action type, and
  * procedural bulk so the dataset is non-toy.

Outputs (into ``cos/fixtures/data/``):
  gmail.json / x.json / whatsapp.json — provider-native message shapes
  asana.json    — projects, milestones (tasks flagged is_milestone), tasks
  scenario.json — owner, team, contacts, projects, milestones, the labeled scenarios
                  (ground truth for the brain, tests, and the demo), links, counts

Deterministic: seeded, anchored to a fixed base date.
"""

from __future__ import annotations

import base64
import json
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from faker import Faker

DATA_DIR = Path(__file__).parent / "data"
BASE = datetime(2026, 7, 1, 9, 0, tzinfo=timezone.utc)

fake = Faker()
Faker.seed(42)
rng = random.Random(42)

OWNER = {"name": "Dmitrii Konyrev", "email": "konyrevdmitriy@gmail.com",
         "x_handle": "dmitrii_cos", "x_user_id": "1000000000000000001",
         "whatsapp": "+15550000001"}

# internal team — targets for delegate / escalate / forward / assign
TEAM = [
    {"name": "Nadia Cohen", "role": "CFO"},
    {"name": "Victor Ruiz", "role": "Head of Engineering"},
    {"name": "Mia Anders", "role": "Recruiter"},
]

BAY = {"SF Bay Area", "Palo Alto", "San Francisco", "Menlo Park"}

# ---- the cast (named senders) -----------------------------------------------
CONTACTS = [
    {"id": "c1", "name": "Sarah Lin", "email": "sarah.lin@sequoia-example.com",
     "x_handle": "sarahlin_vc", "whatsapp": "+14155550111", "org": "Sequoia (example)",
     "region": "SF Bay Area", "regional": True},
    {"id": "c2", "name": "Marcus Bell", "email": "marcus@acme-partners.example",
     "x_handle": "marcusbell", "whatsapp": "+14155550112", "org": "Acme Partners",
     "region": "SF Bay Area", "regional": True},
    {"id": "c3", "name": "Priya Nair", "email": "priya.nair@northwind.example",
     "x_handle": "priyanair", "whatsapp": "+442075550113", "org": "Northwind",
     "region": "London", "regional": False},
    {"id": "c4", "name": "Tom Reyes", "email": "tom.reyes@candidatemail.example",
     "x_handle": "treyes", "whatsapp": "+14155550114", "org": "(candidate)",
     "region": "SF Bay Area", "regional": True},
    {"id": "c5", "name": "Ana García", "email": "ana@lease-realty.example",
     "x_handle": "anagarcia_re", "whatsapp": "+14155550115", "org": "Lease Realty",
     "region": "SF Bay Area", "regional": True},
    {"id": "c6", "name": "David Okafor", "email": "david@fintech-news.example",
     "x_handle": "davidokafor", "whatsapp": "+2348055550116", "org": "Fintech Weekly",
     "region": "Lagos", "regional": False},
    {"id": "c7", "name": "Emma Wright", "email": "emma.wright@boardco.example",
     "x_handle": "emmawright", "whatsapp": "+14155550117", "org": "BoardCo",
     "region": "SF Bay Area", "regional": True},
    {"id": "c8", "name": "Kenji Watanabe", "email": "kenji@supply-example.jp",
     "x_handle": "kenjiw", "whatsapp": "+8150555118", "org": "Supply KK",
     "region": "Tokyo", "regional": False},
    {"id": "c9", "name": "Rachel Kim", "email": "rachel.kim@coudert-example.com",
     "x_handle": "rachelkim_esq", "whatsapp": "+14155550119", "org": "Coudert (counsel)",
     "region": "SF Bay Area", "regional": True},
    {"id": "c10", "name": "Dana Fox", "email": "dana.fox@megacorp.example",
     "x_handle": "danafox", "whatsapp": "+12125550120", "org": "MegaCorp (customer)",
     "region": "New York", "regional": False},
    {"id": "c11", "name": "Leo Martin", "email": "leo@leomartin.example",
     "x_handle": "leomartin", "whatsapp": "+14155550121", "org": "Founder",
     "region": "SF Bay Area", "regional": True},
    {"id": "c12", "name": "Bill Turner", "email": "bill@turner-accounting.example",
     "x_handle": "billturner", "whatsapp": "+14155550122", "org": "Turner Accounting",
     "region": "SF Bay Area", "regional": True},
    {"id": "c13", "name": "Chad Miller", "email": "chad@growthhackerpro.example",
     "x_handle": "chadgrowth", "whatsapp": "+13105550123", "org": "GrowthHackerPro",
     "region": "Remote", "regional": False},
    {"id": "c14", "name": "Greg Salinas", "email": "greg@meridian-vc.example",
     "x_handle": "gregsalinas", "whatsapp": "+16175550124", "org": "Meridian VC",
     "region": "Boston", "regional": False},
    {"id": "c15", "name": "Sam Patel", "email": "sam.patel@futureco.example",
     "x_handle": "sampatel", "whatsapp": "+14155550125", "org": "FutureCo",
     "region": "SF Bay Area", "regional": True},
    {"id": "c16", "name": "Ravi Desai", "email": "ravi@integrately-example.in",
     "x_handle": "ravidesai", "whatsapp": "+919155550126", "org": "Integrately",
     "region": "Bangalore", "regional": False},
]


def x_uid(cid: str) -> str:
    return "2" + cid.replace("c", "").replace("p", "9").zfill(18)


# ---- projects + milestones ---------------------------------------------------
PROJECTS = [
    {"gid": "1201000000000001", "name": "Fundraise"},
    {"gid": "1201000000000002", "name": "Board"},
    {"gid": "1201000000000003", "name": "Hiring"},
    {"gid": "1201000000000004", "name": "Product"},
    {"gid": "1201000000000005", "name": "Ops"},
    {"gid": "1201000000000006", "name": "Sales"},
]
# milestones are tasks with is_milestone=True
MILESTONES = [
    {"gid": "1204000000000001", "name": "Board approves Series A", "due_on": "2026-07-11",
     "project": "1201000000000001"},
    {"gid": "1204000000000002", "name": "Series A closes", "due_on": "2026-07-18",
     "project": "1201000000000001"},
    {"gid": "1204000000000003", "name": "Q3 board meeting", "due_on": "2026-07-12",
     "project": "1201000000000002"},
    {"gid": "1204000000000004", "name": "Head of Sales offer out", "due_on": "2026-07-09",
     "project": "1201000000000003"},
    {"gid": "1204000000000005", "name": "v2 launch", "due_on": "2026-07-25",
     "project": "1201000000000004"},
    {"gid": "1204000000000006", "name": "Office lease signed", "due_on": "2026-07-04",
     "project": "1201000000000005"},
    {"gid": "1204000000000007", "name": "Acme partnership LOI", "due_on": "2026-07-15",
     "project": "1201000000000006"},
]
CURATED_TASKS = [
    {"gid": "1202000000000001", "name": "Review Series A term sheet with counsel",
     "notes": "Valuation + board terms. Sarah wants redline by Friday.",
     "project": "1201000000000001", "due_on": "2026-07-07", "completed": False},
    {"gid": "1202000000000002", "name": "Fill revenue slide in Q3 board deck",
     "notes": "Board circulation on the 12th.", "project": "1201000000000002",
     "due_on": "2026-07-10", "completed": False},
    {"gid": "1202000000000003", "name": "Schedule Head of Sales final panel",
     "notes": "Tom Reyes — strong.", "project": "1201000000000003",
     "due_on": "2026-07-08", "completed": False},
    {"gid": "1202000000000004", "name": "Sign Acme LOI", "notes": "Terms under review.",
     "project": "1201000000000006", "due_on": "2026-07-15", "completed": False},
    {"gid": "1202000000000005", "name": "Sign office lease", "notes": "3-year, same terms.",
     "project": "1201000000000005", "due_on": "2026-07-04", "completed": False},
    {"gid": "1202000000000006", "name": "Send June investor update", "notes": "Done.",
     "project": "1201000000000001", "due_on": "2026-06-28", "completed": True},
    {"gid": "1202000000000007", "name": "Confirm Q4 supply volume", "notes": "Lock pricing.",
     "project": "1201000000000005", "due_on": "2026-07-15", "completed": False},
    {"gid": "1202000000000008", "name": "X integration with Integrately",
     "notes": "May be cancelled.", "project": "1201000000000004",
     "due_on": "2026-07-20", "completed": False},
]

# ---- the 16 labeled scenarios ------------------------------------------------
# THREADS drive message generation; SCENARIO_META holds the expected labels.
THREADS = [
    {"topic": "sarah-series-a", "channel": "gmail", "contact": "c1",
     "subject": "Series A term sheet — next steps", "turns": [
        ("c1", "Hi Dmitrii, great catching up. Attaching the draft term sheet — we'd love "
               "to lead your Series A. Can you review the valuation and board terms and send "
               "thoughts by Friday?"),
        ("owner", "Thanks Sarah, this is exciting. Reviewing with counsel now, will revert "
                  "with comments Thursday."),
        ("c1", "Perfect. One open question: are you open to a board observer seat for us in "
               "addition to the one board seat?")]},
    {"topic": "sarah-series-a", "channel": "x", "contact": "c1", "kind": "dm", "turns": [
        ("c1", "quick nudge on the term sheet — partners meeting is Monday, would love your "
               "redline before then 🙏")]},

    {"topic": "counsel-terms", "channel": "gmail", "contact": "c9",
     "subject": "Re: Series A — open terms", "turns": [
        ("c9", "Reviewed Sequoia's draft. Two calls need YOU: (1) they want a board-observer "
               "seat on top of the board seat, (2) pro-rata rights at 1.5x. How aggressive do "
               "you want to be? I can push back on both but need your read.")]},

    {"topic": "board-deck", "channel": "gmail", "contact": "c7",
     "subject": "Q3 board deck — draft for review", "turns": [
        ("c7", "Sharing the Q3 board deck skeleton. Please fill in the revenue and hiring "
               "slides before we circulate to the board on the 12th."),
        ("owner", "Got it Emma — I'll take the revenue slide, can you own hiring?")]},
    {"topic": "board-deck", "channel": "whatsapp", "contact": "c7", "turns": [
        ("c7", "did you get a chance to look at the deck? board is asking for it early")]},

    {"topic": "hiring-sales", "channel": "gmail", "contact": "c4",
     "subject": "Head of Sales — Tom Reyes", "turns": [
        ("c4", "Following up on our chat about the Head of Sales role. I'm very interested — "
               "attaching my 90-day plan.")]},
    {"topic": "hiring-sales", "channel": "x", "contact": "c4", "kind": "mention", "turns": [
        ("c4", "@dmitrii_cos really enjoyed our conversation about the sales role — excited "
               "about what you're building!")]},

    {"topic": "acme-partnership", "channel": "gmail", "contact": "c2",
     "subject": "Acme × your team — partnership proposal", "turns": [
        ("c2", "Proposal attached. If the integration terms work, we can co-market at the "
               "summit. Can we get an LOI signed by the 15th?")]},

    {"topic": "office-lease", "channel": "whatsapp", "contact": "c5", "turns": [
        ("c5", "Hi Dmitrii — landlord needs a decision on the lease renewal by Friday. Same "
               "terms, 3-year. Want me to counter on the rent?")]},

    {"topic": "customer-escalation", "channel": "whatsapp", "contact": "c10", "turns": [
        ("c10", "Dmitrii — your API has been down for 2 hours and my whole team is blocked. "
                "This is unacceptable, we need an ETA NOW.")]},
    {"topic": "customer-escalation", "channel": "x", "contact": "c10", "kind": "mention",
     "turns": [("c10", "@dmitrii_cos your API is down and support isn't responding. Not a "
                       "great look.")]},

    {"topic": "podcast", "channel": "x", "contact": "c6", "kind": "mention", "turns": [
        ("c6", "@dmitrii_cos would you come on Fintech Weekly to talk about your Series A? "
               "30 min, remote.")]},

    {"topic": "intro-request", "channel": "gmail", "contact": "c11",
     "subject": "Intro to Sarah at Sequoia?", "turns": [
        ("c11", "Hey Dmitrii — I know you're close with Sarah Lin at Sequoia. Any chance you'd "
                "intro me? Raising my seed and she's perfect.")]},

    {"topic": "finance-forward", "channel": "gmail", "contact": "c12",
     "subject": "Q2 tax filing — question", "turns": [
        ("c12", "Quick question on the R&D credit for your Q2 filing — which entity should we "
                "book the contractor costs under?")]},

    {"topic": "stale-outbound", "channel": "gmail", "contact": "c14",
     "subject": "Room in the Series A?", "turns": [
        ("owner", "Hi Greg — following up from our call. We'd love to have Meridian in the "
                  "round, there's room for $500k. Can you confirm by end of week?")]},

    {"topic": "priya-thanks", "channel": "gmail", "contact": "c3",
     "subject": "June investor update — thanks", "turns": [
        ("c3", "Thanks for the June update, numbers look strong."),
        ("owner", "Appreciate it Priya! Let's catch up next month.")]},

    {"topic": "cold-sales", "channel": "gmail", "contact": "c13",
     "subject": "10x your pipeline in 30 days 🚀", "turns": [
        ("c13", "Hi CEO, I help startups 10x their outbound with our AI SDR. Got 15 min this "
                "week for a quick demo? Just need a credit card to start the trial.")]},

    {"topic": "meeting-request", "channel": "gmail", "contact": "c15",
     "subject": "Grab 30 min next week?", "turns": [
        ("c15", "Would love to catch up and hear about the raise — do you have 30 minutes next "
                "week? Flexible on timing.")]},

    {"topic": "cancelled-integration", "channel": "gmail", "contact": "c16",
     "subject": "Winding down the integration", "turns": [
        ("c16", "Heads up — we've decided to sunset the Integrately integration on our side, "
                "so no need to keep the joint work item open. Thanks for the effort!")]},

    {"topic": "supply", "channel": "gmail", "contact": "c8",
     "subject": "Q4 supply commitments", "turns": [
        ("c8", "We need your Q4 volume commitment by the 15th to lock pricing. Forecast "
               "attached.")]},
]

SCENARIO_META = {
    "sarah-series-a": {"action": "REPLY", "asana": "COMMENT_ON_MILESTONE",
                       "milestone": "Series A closes", "priority": "urgent", "hero": True},
    "counsel-terms": {"action": "NEEDS_INPUT", "asana": None, "priority": "high",
                      "hero": True},
    "board-deck": {"action": "REPLY", "asana": "UPDATE_TASK",
                   "task": "Fill revenue slide in Q3 board deck",
                   "milestone": "Q3 board meeting", "priority": "high"},
    "hiring-sales": {"action": "REPLY", "asana": "UPDATE_TASK", "assign": "Mia Anders",
                     "milestone": "Head of Sales offer out", "priority": "medium"},
    "acme-partnership": {"action": "REPLY", "asana": "CREATE_TASK",
                         "milestone": "Acme partnership LOI", "priority": "medium"},
    "office-lease": {"action": "REPLY", "asana": "COMPLETE_MILESTONE",
                     "milestone": "Office lease signed", "priority": "high"},
    "customer-escalation": {"action": "ESCALATE", "asana": "CREATE_TASK",
                            "target": "Victor Ruiz", "priority": "urgent", "hero": True},
    "podcast": {"action": "DECLINE", "asana": None, "priority": "low"},
    "intro-request": {"action": "INTRODUCE", "asana": None, "priority": "medium"},
    "finance-forward": {"action": "FORWARD", "asana": None, "target": "Nadia Cohen",
                        "priority": "low"},
    "stale-outbound": {"action": "FOLLOW_UP", "asana": None, "priority": "medium"},
    "priya-thanks": {"action": "NO_ACTION", "asana": "COMPLETE_TASK",
                     "task": "Send June investor update", "priority": "low"},
    "cold-sales": {"action": "FLAG_SPAM", "asana": None, "priority": "low"},
    "meeting-request": {"action": "SCHEDULE_MEETING", "asana": None, "priority": "low"},
    "cancelled-integration": {"action": "REPLY", "asana": "DELETE_TASK",
                              "task": "X integration with Integrately", "priority": "low"},
    "supply": {"action": "REPLY", "asana": "UPDATE_TASK",
               "task": "Confirm Q4 supply volume", "priority": "medium"},
}

# ---- relationships (hard facts) + prior-history simulation -------------------
# Per-contact relationship type + a fact that can't be derived from messages alone.
RELATIONSHIPS = {
    "c1": {"type": "investor", "since": "2024-02", "note": "Led your seed round; now leading the Series A."},
    "c2": {"type": "partner", "since": "2026-03", "note": "BD lead at Acme; partnership LOI in progress."},
    "c3": {"type": "investor", "since": "2024-02", "note": "Existing seed investor (Northwind)."},
    "c4": {"type": "candidate", "since": "2026-05", "note": "Head of Sales finalist."},
    "c5": {"type": "vendor", "since": "2025-09", "note": "Commercial realtor handling the office lease."},
    "c6": {"type": "press", "since": "2026-01", "note": "Reporter at Fintech Weekly."},
    "c7": {"type": "board", "since": "2024-06", "note": "Runs board operations at BoardCo."},
    "c8": {"type": "vendor", "since": "2025-01", "note": "Key supplier (Supply KK)."},
    "c9": {"type": "counsel", "since": "2026-06", "note": "Outside counsel on the Series A."},
    "c10": {"type": "customer", "since": "2025-04", "note": "VP Eng at MegaCorp, your largest customer."},
    "c11": {"type": "founder", "since": "2023-11", "note": "Founder friend, raising his seed."},
    "c12": {"type": "vendor", "since": "2024-01", "note": "Your accountant."},
    "c13": {"type": "cold", "since": "2026-07", "note": "Cold outbound salesperson; no prior relationship."},
    "c14": {"type": "investor", "since": "2026-06", "note": "Prospective Series A investor (Meridian)."},
    "c15": {"type": "contact", "since": "2025-12", "note": "Wants to reconnect."},
    "c16": {"type": "partner", "since": "2025-10", "note": "Integration partner (Integrately)."},
}
HIST_OPENERS = [
    "Following up from our last call — sharing the notes we discussed.",
    "Thanks again for the time last month, really helpful.",
    "Great to reconnect. Here's the doc I mentioned.",
    "Quick recap of where we landed on the last item.",
    "Appreciated the intro — closing the loop on it.",
]


def make_history_threads(named_ids: list[str]) -> list[dict]:
    """Older, resolved email threads per named contact so prior history is real."""
    out = []
    for cid in named_ids:
        if cid in ("c13", "c14"):   # cold salesperson + new prospective investor: no history
            continue
        for i in range(rng.randint(1, 3)):
            out.append({"topic": f"hist-{cid}-{i}", "channel": "gmail", "contact": cid,
                        "subject": rng.choice(["Catching up", "Recap", "Following up",
                                               "Notes from our call"]),
                        "turns": [(cid, rng.choice(HIST_OPENERS)),
                                  ("owner", "Thanks — appreciate it. Talk soon.")],
                        "history": True})
    return out


# ---- procedural bulk ---------------------------------------------------------
REGIONS = ["SF Bay Area", "Palo Alto", "New York", "London", "Berlin", "Austin",
           "Toronto", "Singapore", "Remote"]
SUBJECTS = ["Intro request", "Customer question", "Vendor invoice", "Scheduling a call",
            "Contract for review", "Press inquiry", "Partnership idea", "Candidate referral",
            "Product feedback", "Renewal question", "Speaking invitation", "Demo request"]
INBOUND = [
    "Hi Dmitrii, {s}. Could you take a look and let me know by {day}?",
    "Quick one — {s}. Do you have 15 minutes this week?",
    "Following up on {s}. Any update on your side?",
    "We'd love your input on {s}. Attaching details.",
]
OWNER_REPLIES = ["Thanks — taking a look now, will revert shortly.",
                 "Appreciate it. Let me loop in the team and get back to you.",
                 "Got it, this works for me. Let's proceed."]


def make_proc_contacts(n: int) -> list[dict]:
    out = []
    for i in range(1, n + 1):
        name = fake.name()
        region = rng.choice(REGIONS)
        out.append({"id": f"p{i}", "name": name, "email": fake.email(),
                    "x_handle": name.lower().replace(" ", "").replace(".", "")[:15],
                    "whatsapp": "+1415" + str(5551000 + i), "org": fake.company(),
                    "region": region, "regional": region in BAY})
    return out


def make_proc_threads(contacts: list[dict], n: int) -> list[dict]:
    out = []
    for i in range(n):
        c = rng.choice(contacts)
        r = rng.random()
        channel = "gmail" if r < 0.5 else ("x" if r < 0.8 else "whatsapp")
        kind = "dm" if (channel == "x" and rng.random() < 0.35) else "mention"
        subj = rng.choice(SUBJECTS)
        first = rng.choice(INBOUND).format(
            s=subj.lower(), day=rng.choice(["Friday", "Monday", "EOD", "the 15th"]))
        if channel == "x" and kind == "mention":
            first = f"@{OWNER['x_handle']} " + first
        turns = [(c["id"], first)]
        roll = rng.random()
        if roll < 0.35:
            turns.append(("owner", rng.choice(OWNER_REPLIES)))
        elif roll < 0.5:
            turns.append((c["id"], "Just bumping this — thanks!"))
        out.append({"topic": f"proc-{i}", "subject": subj if channel == "gmail" else "",
                    "channel": channel, "contact": c["id"], "kind": kind, "turns": turns})
    return out


def make_proc_tasks(n: int) -> list[dict]:
    verbs = ["Follow up on", "Review", "Approve", "Schedule", "Prepare", "Close out"]
    out = []
    for i in range(1, n + 1):
        proj = rng.choice(PROJECTS)
        out.append({"gid": f"12029000000{i:05d}",
                    "name": f"{rng.choice(verbs)} {rng.choice(SUBJECTS).lower()}",
                    "notes": fake.sentence(), "project": proj["gid"],
                    "due_on": (BASE + timedelta(days=rng.randint(-10, 20))).strftime("%Y-%m-%d"),
                    "completed": rng.random() < 0.25})
    return out


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode()


@dataclass
class State:
    gmail: list = field(default_factory=list)
    x_mentions: list = field(default_factory=list)
    x_dms: list = field(default_factory=list)
    x_sent: list = field(default_factory=list)
    x_users: dict = field(default_factory=dict)
    wa: list = field(default_factory=list)
    wa_contacts: dict = field(default_factory=dict)
    wa_sent: list = field(default_factory=list)
    awaiting: list = field(default_factory=list)
    topic_channels: dict = field(default_factory=dict)


def emit(t: dict, seq: int, by_id: dict, st: State) -> None:
    ch, contact = t["channel"], by_id[t["contact"]]
    thread_key = f"{ch[:2]}thr-{seq:03d}"
    st.topic_channels.setdefault(t["topic"], set()).add(ch)
    if t.get("history"):
        ts = BASE - timedelta(days=rng.randint(30, 150), hours=rng.randint(0, 12))
    else:
        ts = BASE - timedelta(days=rng.randint(0, 20), hours=rng.randint(0, 12))
    last_incoming = None

    for i, (who, text) in enumerate(t["turns"]):
        ts = ts + timedelta(hours=3 + i)
        outgoing = who == "owner"
        internal_id = f"{ch}-{t['topic']}-{i}"

        if ch == "gmail":
            frm = (f'{OWNER["name"]} <{OWNER["email"]}>' if outgoing
                   else f'{contact["name"]} <{contact["email"]}>')
            to = (f'{contact["name"]} <{contact["email"]}>' if outgoing
                  else f'{OWNER["name"]} <{OWNER["email"]}>')
            st.gmail.append({
                "id": f"gmailmsg-{seq:03d}-{i}", "threadId": thread_key,
                "labelIds": ["SENT"] if outgoing else ["INBOX", "UNREAD"],
                "internalDate": str(int(ts.timestamp() * 1000)), "snippet": text[:80],
                "payload": {"mimeType": "text/plain", "headers": [
                    {"name": "From", "value": frm}, {"name": "To", "value": to},
                    {"name": "Subject", "value": t.get("subject", "")},
                    {"name": "Date", "value": ts.strftime("%a, %d %b %Y %H:%M:%S %z")}],
                    "body": {"data": _b64url(text), "size": len(text)}}})
            if not outgoing:
                last_incoming = internal_id

        elif ch == "x":
            uid = x_uid(contact["id"])
            st.x_users[uid] = {"id": uid, "name": contact["name"],
                               "username": contact["x_handle"]}
            st.x_users[OWNER["x_user_id"]] = {"id": OWNER["x_user_id"],
                                              "name": OWNER["name"],
                                              "username": OWNER["x_handle"]}
            tid = f"9{seq:03d}{i}00000000000"
            conv = f"18{seq:03d}00000000000"
            created = ts.strftime("%Y-%m-%dT%H:%M:%S.000Z")
            if outgoing:
                st.x_sent.append({"id": tid, "text": text,
                                  "author_id": OWNER["x_user_id"],
                                  "created_at": created, "conversation_id": conv})
            elif t.get("kind") == "dm":
                st.x_dms.append({"id": tid, "event_type": "MessageCreate", "text": text,
                                 "sender_id": uid, "dm_conversation_id": conv,
                                 "created_at": created})
                last_incoming = internal_id
            else:
                st.x_mentions.append({"id": tid, "text": text, "author_id": uid,
                                      "created_at": created, "conversation_id": conv})
                last_incoming = internal_id

        elif ch == "whatsapp":
            st.wa_contacts[contact["whatsapp"]] = {
                "wa_id": contact["whatsapp"].lstrip("+"),
                "profile": {"name": contact["name"]}}
            wamid = f"wamid.{seq:03d}{i}{'0' * 18}"
            unix = str(int(ts.timestamp()))
            if outgoing:
                st.wa_sent.append({"id": wamid, "to": contact["whatsapp"].lstrip("+"),
                                   "timestamp": unix, "type": "text", "text": {"body": text}})
            else:
                st.wa.append({"id": wamid, "from": contact["whatsapp"].lstrip("+"),
                              "timestamp": unix, "type": "text", "text": {"body": text}})
                last_incoming = internal_id

    if t["turns"][-1][0] != "owner" and last_incoming:
        st.awaiting.append(last_incoming)


def build() -> dict:
    by_id = {c["id"]: c for c in CONTACTS}
    proc_contacts = make_proc_contacts(26)
    by_id.update({c["id"]: c for c in proc_contacts})

    st = State()
    seq = 0
    for t in THREADS:
        seq += 1
        emit(t, seq, by_id, st)
    for t in make_history_threads([c["id"] for c in CONTACTS]):   # prior relationship history
        seq += 1
        emit(t, seq, by_id, st)
    for t in make_proc_threads(proc_contacts, 80):
        seq += 1
        emit(t, seq, by_id, st)

    links = [{"topic": tp, "channels": sorted(ch)}
             for tp, ch in st.topic_channels.items() if len(ch) > 1]

    # Asana: milestones (is_milestone) + curated tasks + procedural, all normalized
    def task_row(row, is_ms=False):
        return {
            "gid": row["gid"], "name": row["name"], "notes": row.get("notes", ""),
            "completed": row.get("completed", False), "due_on": row.get("due_on"),
            "resource_subtype": "milestone" if is_ms else "default_task",
            "is_milestone": is_ms,
            "assignee": {"gid": "1203000000000001", "name": OWNER["name"]},
            "projects": [{"gid": row["project"],
                          "name": next(p["name"] for p in PROJECTS
                                       if p["gid"] == row["project"])}],
            "permalink_url": f"https://app.asana.com/0/{row['project']}/{row['gid']}"}

    tasks = ([task_row(m, is_ms=True) for m in MILESTONES]
             + [task_row(t) for t in CURATED_TASKS]
             + [task_row(t) for t in make_proc_tasks(18)])
    asana = {"projects": PROJECTS, "tasks": tasks, "stories": {}}

    # scenario ground truth for the brain / tests / demo
    scenarios = []
    scen_channels: dict[str, set] = {}
    for t in THREADS:
        scen_channels.setdefault(t["topic"], set()).add(t["channel"])
    for key, meta in SCENARIO_META.items():
        contact_id = next(t["contact"] for t in THREADS if t["topic"] == key)
        scenarios.append({"key": key, "contact": by_id[contact_id]["name"],
                          "channels": sorted(scen_channels.get(key, [])),
                          **meta})

    relationships = {by_id[cid]["name"]: {**rel, "org": by_id[cid]["org"]}
                     for cid, rel in RELATIONSHIPS.items()}

    scenario = {
        "owner": OWNER, "team": TEAM, "contacts": CONTACTS + proc_contacts,
        "projects": PROJECTS, "milestones": MILESTONES, "scenarios": scenarios,
        "relationships": relationships,
        "cross_channel_links": links, "awaiting_reply": st.awaiting,
        "counts": {"gmail": len(st.gmail), "x": len(st.x_mentions) + len(st.x_dms),
                   "whatsapp": len(st.wa), "asana_tasks": len(tasks),
                   "milestones": len(MILESTONES), "contacts": len(CONTACTS) + len(proc_contacts),
                   "scenarios": len(scenarios)}}

    return {
        "gmail.json": {"messages": st.gmail},
        "x.json": {"mentions": st.x_mentions, "dm_events": st.x_dms,
                   "sent": st.x_sent, "users": list(st.x_users.values())},
        "whatsapp.json": {"messages": st.wa, "contacts": list(st.wa_contacts.values()),
                          "sent": st.wa_sent},
        "asana.json": asana, "scenario.json": scenario}


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payloads = build()
    for name, payload in payloads.items():
        with open(DATA_DIR / name, "w") as fh:
            json.dump(payload, fh, indent=2)
    sc = payloads["scenario.json"]
    print(f"Wrote fixtures to {DATA_DIR}")
    print(f"  counts: {sc['counts']}")
    print(f"  scenarios: {len(sc['scenarios'])} "
          f"(hero: {[s['key'] for s in sc['scenarios'] if s.get('hero')]})")
    print(f"  cross-channel: {[l['topic'] for l in sc['cross_channel_links'] if 'proc' not in l['topic']]}")


if __name__ == "__main__":
    main()

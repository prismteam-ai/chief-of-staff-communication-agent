"""Baseline methods for the competency questions.

These are deliberately simple (rules + graph + vector) — the number the Claude brain must
beat. Q9 (recommend) is a keyword classifier; Q10 (draft) is left to the brain. Everything is
deterministic and keyless so the eval is reproducible.
"""

from __future__ import annotations

from cos.kb.build import KB
from cos.kb.ontology import Action, AsanaOp, ContextPack, Priority, Recommendation
from cos.models import Message

SPAM = ("unsubscribe", "trial", "credit card", "10x", "🚀", "sdr", "pipeline in")
URGENT = ("is down", "been down", "api down", "outage", "unacceptable", "asap",
          "blocked", "urgent", "eta now")
DECIDE = ("how aggressive", "your read", "how hard", "which entity", "need your read")


def classify_priority(m: Message) -> Priority:
    t = f"{m.subject or ''} {m.body}".lower()
    if any(w in t for w in SPAM):
        return Priority.low
    if any(w in t for w in URGENT):
        return Priority.urgent
    if any(w in t for w in ("by friday", "by the 15th", "by end of week", "deadline",
                            "due ", "eod", "early")):
        return Priority.high
    return Priority.medium


def recommend(m: Message, pack: ContextPack, kb: KB) -> Recommendation:
    """Baseline rule classifier -> communication action + Asana op."""
    t = f"{m.subject or ''} {m.body}".lower()
    action, op, target = Action.REPLY, AsanaOp.NONE, None

    if m.direction.value == "outgoing":   # my own message with no reply back -> chase it
        return Recommendation(message_id=m.id, action=Action.FOLLOW_UP,
                              asana_op=AsanaOp.NONE, priority=classify_priority(m),
                              confidence=0.5)
    if any(w in t for w in SPAM):
        action = Action.FLAG_SPAM
    elif any(w in t for w in URGENT):
        action, op, target = Action.ESCALATE, AsanaOp.CREATE_TASK, "Victor Ruiz"
    elif "intro" in t:
        action = Action.INTRODUCE
    elif any(w in t for w in ("podcast", "press", "interview", "fintech weekly")):
        action = Action.DECLINE
    elif any(w in t for w in ("tax", "invoice", "filing", "accounting", "r&d credit")):
        action, target = Action.FORWARD, "Nadia Cohen"
    elif any(w in t for w in ("30 min", "grab", "catch up", "meet", "next week")):
        action = Action.SCHEDULE_MEETING
    elif any(w in t for w in ("sunset", "winding down", "killing", "cancel", "no need")):
        action, op = Action.REPLY, AsanaOp.DELETE_TASK
    elif any(w in t for w in DECIDE):
        action = Action.NEEDS_INPUT
    elif any(w in t for w in ("thanks", "thank you", "appreciate", "received")):
        action, op = Action.NO_ACTION, AsanaOp.COMPLETE_TASK
    else:
        action = Action.REPLY
        # relate to existing work if a task matches strongly, else create
        top = kb.retriever.top_task(m)
        hits = kb.vector.search(f"{m.subject or ''} {m.body}", k=1, kind="task")
        if top and hits and hits[0]["score"] > 0.18:
            op = AsanaOp.UPDATE_TASK
        elif any(w in t for w in ("proposal", "commit", "loi", "sign", "decision",
                                  "by the")):
            op = AsanaOp.CREATE_TASK

    if "sales role" in t or "head of sales" in t:
        target = "Mia Anders"

    return Recommendation(message_id=m.id, action=action, asana_op=op,
                          priority=classify_priority(m), target=target, confidence=0.5)

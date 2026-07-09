"""Expected outcomes per scenario — the ground truth the judge scores against.

Built from the labeled scenarios (scenario.json) plus a small hand-authored layer of draft
policy (what a reply must / must not contain) and the expected delegation role. Also holds the
generalization set of unseen "tricky" messages.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from cos.agents.roles import ACTION_TO_ROLE
from cos.eval import ground_truth as gt
from cos.kb.ontology import Action


@dataclass
class Expectation:
    key: str
    action: str
    op_family: str | None
    delegate_role: str | None
    priority: str
    must_not_contain: list[str] = field(default_factory=list)   # policy
    must_mention: list[str] = field(default_factory=list)


# per-hero draft policy (kept small + explicit)
_POLICY = {
    "sarah-series-a": {"must_not_contain": ["valuation", "$18", "18m"]},
    "counsel-terms": {"must_not_contain": []},
    "podcast": {"must_mention": ["after"]},        # defer politely
}


def _op_family(op: str | None) -> str | None:
    if not op:
        return None
    return ("comment" if "COMMENT" in op else "complete" if "COMPLETE" in op
            else "create" if "CREATE" in op else "update" if "UPDATE" in op
            else "delete" if "DELETE" in op else "none")


def for_scenarios(kb) -> list[Expectation]:
    out = []
    for c in gt.cases(kb):
        try:
            role = ACTION_TO_ROLE.get(Action(c.action))
        except ValueError:
            role = None
        pol = _POLICY.get(c.key, {})
        out.append(Expectation(
            key=c.key, action=c.action, op_family=_op_family(c.asana),
            delegate_role=role, priority=c.priority,
            must_not_contain=pol.get("must_not_contain", []),
            must_mention=pol.get("must_mention", [])))
    return out


# unseen generalization set (mirrors tests/test_tricky_messages GOLDEN)
TRICKY: list[tuple[str, str]] = [
    ("URGENT!!! Limited-time: 10x your revenue, just add your card to start.", "FLAG_SPAM"),
    ("Any chance we can find 30 minutes next week to catch up?", "SCHEDULE_MEETING"),
    ("Could you make an introduction to your CFO?", "INTRODUCE"),
    ("How hard should we push on the liquidation preference?", "NEEDS_INPUT"),
    ("Quick question on the R&D tax credit for the Q2 filing.", "FORWARD"),
    ("We've decided to sunset the integration, no need to keep it open.", "REPLY"),
    ("Thanks so much! Before you go, the board packet is due Friday and I still "
     "need your revenue numbers.", "REPLY"),
    ("Our production API returned 500s for a full hour this morning.", "ESCALATE"),
    ("Would you comment on the rumors about layoffs at your company?", "DECLINE"),
    ("I'll take care of the vendor contract, nothing needed from you.", "NO_ACTION"),
]

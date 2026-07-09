"""LLM-as-judge tests (mocked) + the deterministic style metric + expectations integrity."""

import os

import pytest

from cos.agents.contracts import AgentResult, JudgeVerdict
from cos.kb.ontology import Action, AsanaOp, Draft, Priority, Recommendation


def _result():
    return AgentResult(message_id="m",
                       recommendation=Recommendation(message_id="m", action=Action.REPLY,
                                                     asana_op=AsanaOp.NONE,
                                                     priority=Priority.high),
                       draft=Draft(message_id="m", text="Thanks, on it."),
                       facts_used=["Sender: Sarah — investor"])


def test_judge_returns_verdict(monkeypatch):
    from cos.eval import judge as judgemod
    from cos.eval.expectations import Expectation
    from cos.models import Channel, Direction, Message, Participant
    from datetime import datetime, timezone

    canned = JudgeVerdict(action_correct=1, op_correct=1, delegation_correct=1, uses_facts=1,
                          policy_ok=1, style_match=0.9, no_hallucination=1, overall=0.95,
                          passed=True, rationale="ok")
    monkeypatch.setattr(judgemod, "structured",
                        lambda schema, **k: type("R", (), {"invoke": lambda s, p: canned})())
    m = Message(id="m", channel=Channel.gmail, thread_id="t",
                sender=Participant(id="p", name="Sarah"),
                timestamp=datetime.now(timezone.utc), body="hi", direction=Direction.incoming)
    exp = Expectation(key="k", action="REPLY", op_family="none", delegate_role=None,
                      priority="high")
    v = judgemod.judge(m, _result(), exp)
    assert v.passed and v.overall == 0.95


def test_style_score_discriminates(mock_server):
    from cos.agents import style
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    kb = build_kb()
    good = "Thanks Sarah, reviewing with counsel now. Will send comments Thursday."
    bad = "Thank you ever so much — I shall endeavour to reply at my earliest convenience —"
    assert style.style_score(kb, good) > style.style_score(kb, bad)


def test_expectations_reference_valid_actions(mock_server):
    from cos.eval import expectations
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    valid = {a.value for a in Action}
    for e in expectations.for_scenarios(build_kb()):
        assert e.action in valid
    assert all(a in valid for _, a in expectations.TRICKY)


@pytest.mark.skipif(not os.environ.get("RUN_LLM"), reason="RUN_LLM not set")
def test_brain_real_llm_smoke(mock_server):
    """Opt-in: exercises the real gpt-5.1 brain on one scenario."""
    from cos.agents import brain
    from cos.eval import ground_truth as gt
    from cos.agents.runtime import get_kb
    from cos.mocks.store import store
    store.reset()
    m = next(c.trigger for c in gt.cases(get_kb()) if c.key == "customer-escalation")
    r = brain.run(m, dry_run=True)
    assert r.recommendation.action is Action.ESCALATE

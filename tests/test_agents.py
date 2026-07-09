"""Agent subsystem tests — LLM fully mocked, so these run keyless in CI.

Covers contracts, role/tool permission boundaries, and the LangGraph brain's routing,
RAG usage, and dry-run safety without any real model call.
"""

import pytest

from cos.agents.contracts import (AgentResult, Delegation, JudgeVerdict, StyleProfile, Triage)
from cos.kb.ontology import Action, AsanaOp, Draft, Priority, Recommendation


# ---- contracts --------------------------------------------------------------
def test_contracts_serialize():
    t = Triage(priority=Priority.high, needs_reply=True)
    assert Triage.model_validate_json(t.model_dump_json()) == t
    v = JudgeVerdict(action_correct=1, op_correct=1, delegation_correct=1, uses_facts=1,
                     policy_ok=1, style_match=1, no_hallucination=1, overall=1, passed=True)
    assert JudgeVerdict.model_validate_json(v.model_dump_json()).passed
    sp = StyleProfile(tone="warm", formality="neutral", signoff="Dmitrii")
    assert sp.uses_emoji is False


# ---- role / tool permission boundaries --------------------------------------
def test_role_permission_boundaries():
    from cos.agents.roles import ROLES
    drafter = {t.name for t in ROLES["drafter"].toolset()}
    asana = {t.name for t in ROLES["asana"].toolset()}
    assert "gmail_send_reply" in drafter and "asana_create_task" not in drafter
    assert "asana_create_task" in asana and "gmail_send_reply" not in asana


def test_action_to_role_map():
    from cos.agents.roles import ACTION_TO_ROLE
    assert ACTION_TO_ROLE[Action.ESCALATE] == "engineering"
    assert ACTION_TO_ROLE[Action.FORWARD] == "cfo"
    assert ACTION_TO_ROLE[Action.SCHEDULE_MEETING] == "scheduler"


def test_send_tools_cover_every_channel():
    from cos.agents.tools import SEND_BY_CHANNEL
    assert set(SEND_BY_CHANNEL) == {"gmail", "x", "whatsapp"}


# ---- brain (LLM mocked) -----------------------------------------------------
_ACTION = {"value": Action.REPLY}
_OP = {"value": AsanaOp.UPDATE_TASK}


def _fake_structured(schema, **kw):
    class _R:
        def invoke(self, prompt):
            if schema is Triage:
                return Triage(priority=Priority.high, needs_reply=True)
            if schema is Recommendation:
                return Recommendation(message_id="x", action=_ACTION["value"],
                                      asana_op=_OP["value"], priority=Priority.high,
                                      target="Victor Ruiz", rationale="do it")
            if schema is Draft:
                return Draft(message_id="x", text="Thanks, on it. Will revert shortly.")
            raise AssertionError(schema)
    return _R()


@pytest.fixture()
def brain_mocked(mock_server, monkeypatch):
    from cos.agents import brain, style
    from cos.mocks.store import store
    store.reset()
    monkeypatch.setattr(brain, "structured", _fake_structured)
    monkeypatch.setattr(style, "owner_style_profile",
                        lambda kb: StyleProfile(tone="warm", formality="neutral",
                                                signoff="Dmitrii"))
    brain._APP = None            # rebuild graph with patched nodes
    monkeypatch.setattr(brain, "_DELEGATOR", None)
    return brain


def test_brain_reply_routes_to_draft(brain_mocked):
    from cos.eval import ground_truth as gt
    from cos.agents.runtime import get_kb
    _ACTION["value"] = Action.REPLY
    m = next(c.trigger for c in gt.cases(get_kb()) if c.key == "sarah-series-a")
    r = brain_mocked.run(m, dry_run=True)
    assert isinstance(r, AgentResult)
    assert r.draft is not None and r.delegation is None
    assert r.facts_used                                   # RAG was used
    assert r.executed_ops == ["[dry-run] UPDATE_TASK"]    # dry-run, no mutation


def test_brain_escalate_routes_to_delegate(brain_mocked):
    from cos.eval import ground_truth as gt
    from cos.agents.runtime import get_kb
    _ACTION["value"] = Action.ESCALATE
    _OP["value"] = AsanaOp.NONE
    m = next(c.trigger for c in gt.cases(get_kb()) if c.key == "customer-escalation")
    r = brain_mocked.run(m, dry_run=True)
    assert r.delegation is not None and r.delegation.role == "engineering"
    assert r.draft is None
    _OP["value"] = AsanaOp.UPDATE_TASK   # reset


def test_brain_no_action_has_no_draft(brain_mocked):
    from cos.eval import ground_truth as gt
    from cos.agents.runtime import get_kb
    _ACTION["value"] = Action.NO_ACTION
    _OP["value"] = AsanaOp.NONE
    m = next(c.trigger for c in gt.cases(get_kb()) if c.key == "priya-thanks")
    r = brain_mocked.run(m, dry_run=True)
    assert r.draft is None and r.delegation is None
    _ACTION["value"], _OP["value"] = Action.REPLY, AsanaOp.UPDATE_TASK

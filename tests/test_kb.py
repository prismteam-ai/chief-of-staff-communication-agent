"""Knowledge-base tests: graph queries + hybrid retrieval on the hero scenarios."""

import pytest


@pytest.fixture(scope="module")
def kb(mock_server):
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()   # clear mutations from earlier tests in the shared mock
    return build_kb()


def test_graph_shape(kb):
    assert len(kb.messages) > 100
    assert len(kb.graph.milestones()) == 7
    assert len(kb.graph.tasks) >= 30
    # identity resolution: Sarah's messages resolve to one person across channels
    sarah_msgs = [m for m in kb.messages if m.sender.name == "Sarah Lin"]
    pids = {kb.graph.person_id_for(m) for m in sarah_msgs}
    assert len(pids) == 1 and None not in pids


def test_cross_channel_link(kb):
    sarah_gmail = next(m for m in kb.messages
                       if m.sender.name == "Sarah Lin" and m.channel.value == "gmail")
    cc = kb.retriever.cross_channel(sarah_gmail)
    assert any(x.channel.value == "x" for x in cc)   # linked to her X DM


def test_related_task_retrieval(kb):
    sarah_gmail = next(m for m in kb.messages
                       if m.sender.name == "Sarah Lin" and m.channel.value == "gmail")
    top = kb.retriever.top_task(sarah_gmail)
    assert top is not None and "series a" in top.name.lower()


def test_context_pack_sources(kb):
    m = next(m for m in kb.messages if m.sender.name == "Sarah Lin")
    pack = kb.retriever.context_pack(m)
    assert pack.preferences and pack.org_facts and pack.style_examples
    assert pack.related_tasks


def test_stale_outbound(kb):
    stale = kb.graph.stale_outbound()
    assert len(stale) == 1   # the Greg / "Room in the Series A?" follow-up


def test_hard_facts(kb):
    sarah = next(m for m in kb.messages
                 if m.sender.name == "Sarah Lin" and m.channel.value == "gmail")
    facts = " ".join(kb.retriever.facts(sarah)).lower()
    assert "investor" in facts                      # relationship type
    assert "prior history" in facts                 # real prior interactions
    assert "series a" in facts and "2026-07" in facts   # company state + a real date
    assert "do not disclose" in facts               # policy fact for investors

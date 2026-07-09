"""Invariants that must hold across the WHOLE corpus, not just hero scenarios.

Runs the classifier + retriever over every ingested message and asserts structural
invariants, no crashes, valid enums, and determinism at scale.
"""

import pytest

from cos.eval import methods
from cos.kb.ontology import Action, AsanaOp
from cos.models import Direction


@pytest.fixture(scope="module")
def kb(mock_server):
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    return build_kb()


def test_message_ids_unique(kb):
    ids = [m.id for m in kb.messages]
    assert len(ids) == len(set(ids))


def test_all_timestamps_tz_aware(kb):
    assert all(m.timestamp.tzinfo is not None for m in kb.messages)


def test_threads_are_single_channel(kb):
    for (channel, _), msgs in kb.graph.threads.items():
        assert all(m.channel.value == channel for m in msgs)


def test_awaiting_and_stale_invariants(kb):
    for thread in kb.graph.awaiting_threads():
        assert thread[-1].direction is Direction.incoming
    for thread in kb.graph.stale_outbound():
        assert all(m.direction is Direction.outgoing for m in thread)


def test_classifier_valid_over_full_corpus(kb):
    for m in kb.messages:
        rec = methods.recommend(m, kb.retriever.context_pack(m), kb)
        assert isinstance(rec.action, Action)
        assert isinstance(rec.asana_op, AsanaOp)


def test_retriever_invariants_over_full_corpus(kb):
    gids = {t.gid for t in kb.graph.tasks}
    for m in kb.messages:
        pack = kb.retriever.context_pack(m)
        for x in pack.cross_channel:
            assert x.channel != m.channel and x.id != m.id      # never self / same channel
        for x in pack.thread_history:
            assert x.id != m.id
        top = kb.retriever.top_task(m)
        assert top is None or top.gid in gids                    # never a phantom task
        assert isinstance(pack.facts, list)


def test_classification_is_deterministic_at_scale(kb):
    run1 = [methods.recommend(m, kb.retriever.context_pack(m), kb).action for m in kb.messages]
    run2 = [methods.recommend(m, kb.retriever.context_pack(m), kb).action for m in kb.messages]
    assert run1 == run2


def test_adversarial_body_suffixes(kb):
    """Appending junk to real messages must not crash or produce invalid output."""
    sample = kb.messages[:20]
    for m in sample:
        m2 = m.model_copy(update={"body": m.body + " \x00﻿ 💥 <script> ' \" ; --"})
        rec = methods.recommend(m2, kb.retriever.context_pack(m2), kb)
        assert isinstance(rec.action, Action)

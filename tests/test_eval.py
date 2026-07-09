"""Eval-harness tests: the baseline scoreboard + determinism."""

import pytest


@pytest.fixture(scope="module")
def report(mock_server):
    from cos.eval.harness import evaluate
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()   # clear mutations from earlier tests in the shared mock
    return evaluate(build_kb())


def test_action_accuracy(report):
    correct, total = report["action"]
    assert total == 16 and correct >= 14        # baseline should be strong


def test_needs_input_and_cross_channel(report):
    assert report["needs_input"][2] == 1.0       # F1
    linked, total = report["cross"]              # matter-linking recall
    assert total > 0 and linked == total         # every cross-channel matter linked


def test_task_hit_and_context(report):
    hit, total = report["task_hit"]
    assert total == 8 and hit == 8
    assert report["ctx_recall"] == 1.0


def test_dashboard_counts(report):
    d = report["dashboard"]
    assert d["messages"] > 100 and d["milestones"] == 7


def test_determinism(mock_server):
    from cos.eval.harness import evaluate
    from cos.kb.build import build_kb
    a = evaluate(build_kb())
    b = evaluate(build_kb())
    assert a["action"] == b["action"] and a["cross"] == b["cross"]

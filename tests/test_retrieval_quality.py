"""Deeper assertions on retrieval + graph correctness (not just 'no crash')."""

import time

import pytest


@pytest.fixture(scope="module")
def kb(mock_server):
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    return build_kb()


def test_embedding_self_similarity_is_one(kb):
    v = kb.vector.embedder.embed("series a term sheet valuation")
    assert abs(float(v @ v) - 1.0) < 1e-6


def test_embedding_symmetry(kb):
    e = kb.vector.embedder
    a, b = e.embed("board deck revenue slide"), e.embed("fill the revenue slide")
    assert abs(float(a @ b) - float(b @ a)) < 1e-9


def test_relevant_task_ranks_above_irrelevant(kb):
    hits = kb.vector.search("series a term sheet valuation board terms", k=5, kind="task")
    assert hits, "no task hits"
    assert "series a" in hits[0]["name"].lower()      # right task ranked first


def test_graph_person_index_is_consistent(kb):
    for pid in kb.graph.by_person:
        assert pid in kb.graph.persons        # no dangling person ids
    for m in kb.messages:
        pid = kb.graph.person_id_for(m)
        assert pid is None or pid in kb.graph.persons


def test_tasks_reference_real_projects(kb):
    project_gids = {p.gid for p in kb.graph.projects}
    for t in kb.graph.tasks:
        for gid in t.project_gids:
            assert gid in project_gids


def test_deadline_regex_no_catastrophic_backtracking():
    from cos.kb.retriever import DEADLINE_RE
    pathological = "by the " + "9" * 100_000 + " never"
    start = time.perf_counter()
    DEADLINE_RE.search(pathological)
    assert time.perf_counter() - start < 0.5    # linear, no ReDoS

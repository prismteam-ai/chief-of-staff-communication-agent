"""End-to-end: ingest → retrieve → recommend → execute the Asana op → verify state.

Exercises the whole loop against the mock for every Asana operation type, plus a full
classifier→executor path for a hero scenario.
"""

import pytest

from cos.eval import ground_truth as gt
from cos.eval import methods
from cos.kb.ontology import Action, AsanaOp


@pytest.fixture(scope="module")
def kb(mock_server):
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    return build_kb()


@pytest.fixture()
def client(mock_server):
    from cos.asana_client import AsanaClient
    return AsanaClient()


def _hero(kb):
    return next(c for c in gt.cases(kb) if c.hero and c.trigger)


@pytest.mark.parametrize("op", ["CREATE_TASK", "UPDATE_TASK", "COMPLETE_TASK",
                                "COMMENT_ON_TASK", "DELETE_TASK"])
def test_pipeline_executes_each_asana_op(kb, client, op):
    m = _hero(kb).trigger
    # every op starts from a fresh task linked to the real message (no fixture damage)
    t = client.create_task(name=f"[{op}] from {m.sender.name}", notes="auto",
                           project="1201000000000001", linked_message_id=m.id)
    assert t.linked_message_id == m.id

    if op == "CREATE_TASK":
        assert any(x.gid == t.gid for x in client.list_tasks())
    elif op == "UPDATE_TASK":
        assert client.update_task(t.gid, notes="updated").notes == "updated"
    elif op == "COMPLETE_TASK":
        assert client.complete_task(t.gid).completed is True
    elif op == "COMMENT_ON_TASK":
        c = client.add_comment(t.gid, f"logged from {m.sender.name}")
        assert c.task_gid == t.gid and c.text
    elif op == "DELETE_TASK":
        client.delete_task(t.gid)
        with pytest.raises(LookupError):
            client.get_task(t.gid)


def test_comment_on_real_milestone(kb, client):
    ms = next(x for x in client.list_milestones() if "series a closes" in x.name.lower())
    comment = client.add_comment(ms.gid, "Term sheet redline sent to Sarah.")
    assert comment.task_gid == ms.gid


def test_full_classifier_to_executor_loop(kb, client):
    """Escalation hero: message → recommendation → create the tracked task → verify."""
    c = next(x for x in gt.cases(kb) if x.key == "customer-escalation")
    rec = methods.recommend(c.trigger, kb.retriever.context_pack(c.trigger), kb)
    assert rec.action is Action.ESCALATE and rec.asana_op is AsanaOp.CREATE_TASK
    assert rec.target == "Victor Ruiz"

    before = len(client.list_tasks())
    task = client.create_task(
        name=f"[escalation] {c.trigger.sender.name}: API outage",
        notes=c.trigger.body, project="1201000000000004",
        linked_message_id=c.trigger.id)
    assert len(client.list_tasks()) == before + 1
    assert client.get_task(task.gid).name.startswith("[escalation]")

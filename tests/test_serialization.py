"""Every model must round-trip losslessly through JSON (needed for the API/UI/agent)."""

from datetime import datetime, timezone

from cos.kb.ontology import (Action, AsanaOp, ContextPack, Priority, Recommendation)
from cos.models import Channel, Direction, Message, Participant, Task


def _msg():
    return Message(id="g:1", channel=Channel.gmail, thread_id="t1",
                   sender=Participant(id="email:a@b.c", name="Ann", email="a@b.c"),
                   timestamp=datetime(2026, 7, 1, 9, tzinfo=timezone.utc),
                   subject="Hi", body="café ☕ 日本語\nline2", direction=Direction.incoming)


def test_message_round_trip():
    m = _msg()
    assert Message.model_validate_json(m.model_dump_json()) == m


def test_task_round_trip():
    t = Task(gid="1", name="Do it", is_milestone=True, due_on="2026-07-18",
             project_gids=["p1"], completed=False)
    assert Task.model_validate_json(t.model_dump_json()) == t


def test_recommendation_round_trip_with_enums():
    r = Recommendation(message_id="g:1", action=Action.ESCALATE,
                       asana_op=AsanaOp.CREATE_TASK, priority=Priority.urgent,
                       target="Victor Ruiz", confidence=0.9)
    back = Recommendation.model_validate_json(r.model_dump_json())
    assert back == r and back.action is Action.ESCALATE


def test_context_pack_round_trip():
    pack = ContextPack(message=_msg(), facts=["Sender: Ann — investor"],
                       preferences=["be concise"], org_facts=["Series A closing"],
                       style_examples=["Thanks, Dmitrii"])
    back = ContextPack.model_validate_json(pack.model_dump_json())
    assert back.message == pack.message and back.facts == pack.facts

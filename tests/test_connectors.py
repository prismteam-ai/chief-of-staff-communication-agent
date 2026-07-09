"""The real SDK connectors, pointed at the mock, return normalized Messages."""

import pytest

from cos.models import Channel, Direction


@pytest.fixture()
def connectors(mock_server):
    # import after the mock_server fixture has set env + cleared the settings cache
    from cos.connectors import GmailConnector, WhatsAppConnector, XConnector
    return GmailConnector(), XConnector(), WhatsAppConnector()


def test_gmail_connector(connectors):
    gmail, _, _ = connectors
    msgs = gmail.list_incoming()
    assert msgs, "gmail returned no messages"
    m = msgs[0]
    assert m.channel is Channel.gmail
    assert m.direction is Direction.incoming        # INBOX filter excludes SENT
    assert m.sender.email and m.provenance["provider"] == "gmail"


def test_x_connector(connectors):
    _, x, _ = connectors
    msgs = x.list_incoming()
    assert msgs and all(m.channel is Channel.x for m in msgs)
    assert any(m.sender.handle and m.sender.handle.startswith("@") for m in msgs)


def test_whatsapp_connector(connectors):
    _, _, wa = connectors
    msgs = wa.list_incoming()
    assert msgs and all(m.channel is Channel.whatsapp for m in msgs)


def test_asana_roundtrip(mock_server):
    from cos.asana_client import AsanaClient
    client = AsanaClient()
    before = client.list_tasks()
    assert len(before) >= 20
    created = client.create_task(name="Reply to Sarah", notes="from thread",
                                 project="1201000000000001",
                                 linked_message_id="gmail:x")
    assert created.linked_message_id == "gmail:x"
    fetched = client.get_task(created.gid)
    assert fetched.name == "Reply to Sarah"
    done = client.complete_task(created.gid)
    assert done.completed is True


def test_asana_milestones(mock_server):
    from cos.asana_client import AsanaClient
    client = AsanaClient()
    milestones = client.list_milestones()
    assert len(milestones) >= 5 and all(m.is_milestone for m in milestones)
    assert any(m.name == "Series A closes" for m in milestones)
    made = client.create_milestone("Wire received", project="1201000000000001",
                                   due_on="2026-07-18")
    assert made.is_milestone is True


def test_asana_comment_and_delete(mock_server):
    from cos.asana_client import AsanaClient
    client = AsanaClient()
    t = client.create_task(name="Temp", project="1201000000000001")
    comment = client.add_comment(t.gid, "logged the decision")
    assert comment.text == "logged the decision" and comment.task_gid == t.gid
    assigned = client.assign_task(t.gid, "Mia Anders")
    assert assigned.assignee == "Mia Anders"
    client.delete_task(t.gid)
    # deleting again would error; confirm it's gone from the list
    assert all(x.gid != t.gid for x in client.list_tasks())


def test_modular_registry(mock_server):
    from cos.connectors import Connector, all_connectors
    conns = all_connectors()
    assert len(conns) == 3
    assert all(isinstance(c, Connector) for c in conns)
    assert {c.name for c in conns} == {"gmail", "x", "whatsapp"}

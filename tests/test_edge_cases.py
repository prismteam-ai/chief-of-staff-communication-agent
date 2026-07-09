"""Edge cases and tricky situations — the paths the happy-path tests miss."""

from datetime import datetime, timezone

import pytest

from cos.models import Channel, Direction, Message, Participant


def _msg(body, *, channel=Channel.gmail, sender=None, direction=Direction.incoming,
         subject=None, thread="t1"):
    sender = sender or Participant(id="email:x@y.z", name="X", email="x@y.z")
    return Message(id="m1", channel=channel, thread_id=thread, sender=sender,
                   timestamp=datetime.now(timezone.utc), body=body, subject=subject,
                   direction=direction)


@pytest.fixture(scope="module")
def kb(mock_server):
    from cos.kb.build import build_kb
    from cos.mocks.store import store
    store.reset()
    return build_kb()


# ---- connector send paths (write side, previously untested) -----------------
def test_gmail_send(mock_server):
    from cos.connectors import GmailConnector
    res = GmailConnector().send_reply("gmthr-001", "Sounds good.", to="a@b.c")
    assert "id" in res and "SENT" in res.get("labelIds", [])


def test_x_send(mock_server):
    from cos.connectors import XConnector
    res = XConnector().send_reply("1800000000000000", "thanks!")
    assert res["id"]


def test_whatsapp_send(mock_server):
    from cos.connectors import WhatsAppConnector
    res = WhatsAppConnector().send_reply("wa:14155550111", "on it", to="14155550111")
    assert res["messages"][0]["id"].startswith("wamid.")


# ---- Asana error / robustness ------------------------------------------------
def test_asana_bad_gid_raises(mock_server):
    from cos.asana_client import AsanaClient
    with pytest.raises(LookupError):
        AsanaClient().get_task("000-does-not-exist")


def test_asana_created_gid_no_collision(mock_server):
    from cos.asana_client import AsanaClient
    c = AsanaClient()
    existing = {t.gid for t in c.list_tasks()}
    made = c.create_task("fresh", project="1201000000000001")
    assert made.gid not in existing


def test_asana_delete_then_missing(mock_server):
    from cos.asana_client import AsanaClient
    c = AsanaClient()
    t = c.create_task("temp", project="1201000000000001")
    c.delete_task(t.gid)
    with pytest.raises(LookupError):
        c.get_task(t.gid)


# ---- graph identity resolution ----------------------------------------------
def test_unknown_sender_is_none(kb):
    stranger = _msg("hi", channel=Channel.x,
                    sender=Participant(id="x:nobody", name="Nobody", handle="@nobody"))
    assert kb.graph.person_for(stranger) is None
    # must not crash and should note first contact
    facts = " ".join(kb.retriever.facts(stranger)).lower()
    pack = kb.retriever.context_pack(stranger)
    assert pack.cross_channel == [] and pack.sender_history == []


def test_identity_normalization(kb):
    # Sarah c1: email, @handle, phone — all case/format variants resolve to one person
    variants = [
        Participant(id="a", name="s", email="SARAH.LIN@SEQUOIA-EXAMPLE.COM"),
        Participant(id="b", name="s", handle="sarahlin_vc"),          # no @
        Participant(id="c", name="s", handle="@SarahLin_VC"),         # mixed case
        Participant(id="d", name="s", handle="+14155550111"),         # phone
    ]
    ids = {kb.graph.person_id_for(_msg("x", sender=v)) for v in variants}
    assert ids == {kb.graph.identity_index["sarah.lin@sequoia-example.com"]}
    assert None not in ids


def test_owner_outgoing_resolves_to_owner(kb):
    owner_msg = _msg("my note", sender=Participant(
        id="owner", name="Dmitrii Konyrev", email="konyrevdmitriy@gmail.com"),
        direction=Direction.outgoing)
    p = kb.graph.person_for(owner_msg)
    assert p is not None and p.is_owner


# ---- facts robustness --------------------------------------------------------
def test_facts_first_contact_for_cold(kb):
    chad = next(m for m in kb.messages if m.sender.name == "Chad Miller")
    facts = " ".join(kb.retriever.facts(chad)).lower()
    assert "first contact" in facts        # cold contact has no prior history


def test_facts_no_crash_on_empty_body_unknown_sender(kb):
    m = _msg("", sender=Participant(id="x:ghost", name="Ghost", handle="@ghost"))
    assert isinstance(kb.retriever.facts(m), list)   # no exception


# ---- vector index boundaries -------------------------------------------------
def test_vector_no_match_and_determinism(kb):
    r = kb.vector.search("zzz qqq totallyunknowntokens", k=3)
    assert len(r) <= 3
    v1 = kb.vector.embedder.embed("series a term sheet")
    v2 = kb.vector.embedder.embed("series a term sheet")
    assert (v1 == v2).all()


# ---- baseline classifier: precedence + boundaries ---------------------------
def test_rule_precedence_spam_beats_urgent(kb):
    from cos.eval import methods
    m = _msg("URGENT: 10x your pipeline in 30 days, just need a credit card")
    rec = methods.recommend(m, kb.retriever.context_pack(m), kb)
    assert rec.action.value == "FLAG_SPAM"      # spam checked before urgent


def test_outgoing_is_follow_up(kb):
    from cos.eval import methods
    m = _msg("following up, any word?", direction=Direction.outgoing)
    assert methods.recommend(m, kb.retriever.context_pack(m), kb).action.value == "FOLLOW_UP"


def test_plain_message_is_reply(kb):
    from cos.eval import methods
    m = _msg("Here are the notes from our chat, let me know your thoughts.")
    assert methods.recommend(m, kb.retriever.context_pack(m), kb).action.value == "REPLY"


def test_priority_classification(kb):
    from cos.eval.methods import classify_priority
    assert classify_priority(_msg("the api is down and we're blocked")).value == "urgent"
    assert classify_priority(_msg("please confirm by the 15th")).value == "high"
    assert classify_priority(_msg("start your free trial")).value == "low"
    assert classify_priority(_msg("just saying hello")).value == "medium"


# ---- deadline detection ------------------------------------------------------
def test_deadline_regex():
    from cos.kb.retriever import DEADLINE_RE
    assert DEADLINE_RE.search("decision by friday").group(0) == "by friday"
    assert DEADLINE_RE.search("commit by the 3rd").group(0) == "by the 3rd"
    assert DEADLINE_RE.search("need it by end of week")
    assert DEADLINE_RE.search("no dates mentioned at all") is None


# ---- mock robustness ---------------------------------------------------------
def test_mock_404_message():
    from fastapi.testclient import TestClient
    from cos.mocks.app import app
    r = TestClient(app).get("/gmail/v1/users/me/messages/nope").json()
    assert "error" in r and r["error"]["code"] == 404


def test_store_reset_restores(mock_server):
    from cos.asana_client import AsanaClient
    from cos.mocks.store import store
    c = AsanaClient()
    before = len(c.list_tasks())
    c.create_task("junk", project="1201000000000001")
    assert len(c.list_tasks()) == before + 1
    store.reset()
    assert len(c.list_tasks()) == before

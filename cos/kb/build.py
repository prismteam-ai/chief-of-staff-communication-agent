"""Build the knowledge base from the real ingestion path + fixtures.

`build_kb()` assumes the provider mock is reachable (the caller wraps it in
`cos.mocks.serve.run_mock`). It ingests messages via the real connectors and Asana via the
real client, then constructs the graph + vector index and returns a `KB` bundle.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parseaddr

from cos.asana_client import AsanaClient
from cos.connectors import all_connectors
from cos.fixtures import DATA_DIR, load
from cos.kb.embeddings import get_embedder
from cos.kb.graph import KnowledgeGraph, Person
from cos.kb.retriever import HybridRetriever
from cos.kb.vector import VectorIndex
from cos.models import Channel, Direction, Message, Participant


@dataclass
class KB:
    graph: KnowledgeGraph
    vector: VectorIndex
    retriever: HybridRetriever
    scenario: dict
    messages: list[Message]


def _owner_style_texts() -> list[str]:
    """The exec's own sent messages across channels — the style corpus."""
    texts: list[str] = []
    gmail = load("gmail.json")
    for m in gmail["messages"]:
        if "SENT" in m.get("labelIds", []):
            data = m["payload"]["body"].get("data", "")
            if data:
                texts.append(base64.urlsafe_b64decode(data).decode(errors="replace"))
    x = load("x.json")
    texts += [t["text"] for t in x.get("sent", [])]
    wa = load("whatsapp.json")
    texts += [s["text"]["body"] for s in wa.get("sent", [])]
    return texts


def _owner_sent_messages(owner: dict) -> list[Message]:
    """The exec's outgoing messages, reconstructed so threads are complete and
    follow-up (stale outbound) detection works. These are not 'incoming' — they are
    added to the graph but not to the actionable message list."""
    me = Participant(id="owner", name=owner["name"], email=owner["email"],
                     handle=owner["email"], is_owner=True)
    out: list[Message] = []
    for m in load("gmail.json")["messages"]:
        if "SENT" not in m.get("labelIds", []):
            continue
        h = {x["name"].lower(): x["value"] for x in m["payload"]["headers"]}
        data = m["payload"]["body"].get("data", "")
        body = base64.urlsafe_b64decode(data).decode(errors="replace") if data else ""
        ts = datetime.fromtimestamp(int(m["internalDate"]) / 1000, timezone.utc)
        out.append(Message(id=f"gmail:{m['id']}", channel=Channel.gmail,
                           thread_id=m["threadId"], sender=me, timestamp=ts,
                           subject=h.get("subject") or None, body=body,
                           direction=Direction.outgoing,
                           provenance={"provider": "gmail", "id": m["id"]}))
    for t in load("x.json").get("sent", []):
        ts = datetime.strptime(t["created_at"], "%Y-%m-%dT%H:%M:%S.000Z").replace(
            tzinfo=timezone.utc)
        out.append(Message(id=f"x:{t['id']}", channel=Channel.x,
                           thread_id=str(t["conversation_id"]), sender=me, timestamp=ts,
                           body=t["text"], direction=Direction.outgoing,
                           provenance={"provider": "x", "id": t["id"]}))
    for s in load("whatsapp.json").get("sent", []):
        ts = datetime.fromtimestamp(int(s["timestamp"]), timezone.utc)
        out.append(Message(id=f"whatsapp:{s['id']}", channel=Channel.whatsapp,
                           thread_id=f"wa:{s['to']}", sender=me, timestamp=ts,
                           body=s["text"]["body"], direction=Direction.outgoing,
                           provenance={"provider": "whatsapp", "id": s["id"]}))
    return out


def _knowledge(name: str) -> list[dict]:
    import json
    with open(DATA_DIR.parent / "knowledge" / name) as fh:
        return json.load(fh)


def build_kb() -> KB:
    scenario = load("scenario.json")

    # ---- ingest (real connectors + client against the mock) -----------------
    messages: list[Message] = []
    for conn in all_connectors():
        try:
            messages.extend(conn.list_incoming())
        except Exception:  # noqa: BLE001 — one channel failing must not empty the inbox
            continue
    asana = AsanaClient()
    tasks = asana.list_tasks()
    projects = asana.list_projects()

    # ---- graph --------------------------------------------------------------
    g = KnowledgeGraph()
    owner = scenario["owner"]
    g.add_person(
        Person(id="owner", name=owner["name"], is_owner=True),
        [owner["email"], "@" + owner["x_handle"], owner["whatsapp"]])
    for c in scenario["contacts"]:
        g.add_person(
            Person(id=c["id"], name=c["name"], org=c.get("org"),
                   region=c.get("region"), regional=c.get("regional", False)),
            [c["email"], "@" + c["x_handle"], c["whatsapp"]])
    for i, t in enumerate(scenario.get("team", [])):
        g.add_person(Person(id=f"team{i}", name=t["name"], is_team=True,
                            role=t.get("role")), [])
    for m in messages:
        g.add_message(m)
    for m in _owner_sent_messages(owner):   # complete threads + enable follow-up detection
        g.add_message(m)
    g.add_tasks(tasks)
    g.add_projects(projects)

    # ---- vector index -------------------------------------------------------
    index = VectorIndex(get_embedder())
    for m in messages:
        index.add(f"{m.subject or ''} {m.body}",
                  {"kind": "message", "id": m.id, "channel": m.channel.value,
                   "thread": m.thread_id})
    for txt in _owner_style_texts():
        index.add(txt, {"kind": "style"})
    for t in tasks:
        index.add(f"{t.name}. {t.notes}",
                  {"kind": "task", "gid": t.gid, "name": t.name,
                   "is_milestone": t.is_milestone})
    for p in _knowledge("preferences.json"):
        index.add(p["value"], {"kind": "pref", "key": p["key"]})
    for f in _knowledge("org_facts.json"):
        index.add(f["text"], {"kind": "orgfact", "source": f["source"]})
    index.build()

    import json
    with open(DATA_DIR.parent / "knowledge" / "company.json") as fh:
        company = json.load(fh)
    retriever = HybridRetriever(g, index, company=company,
                                relationships=scenario.get("relationships", {}))
    return KB(graph=g, vector=index, retriever=retriever, scenario=scenario,
              messages=messages)

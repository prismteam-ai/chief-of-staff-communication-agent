"""LangChain tools over the RAG knowledge base and Asana.

These are the *actions* agents can take. Each role (roles.py) is allowed only a subset — that
is the permission boundary. Retrieval for the main brain happens in a graph node (so RAG
context is always injected), but these read tools are also available to the A2A role agents.
"""

from __future__ import annotations

from langchain_core.tools import tool

from cos.agents.runtime import get_asana, get_connectors, get_kb


@tool
def vector_search(query: str, kind: str = "all") -> str:
    """Semantic search over the knowledge base. kind: message|task|style|pref|orgfact|all."""
    hits = get_kb().vector.search(query, k=5, kind=None if kind == "all" else kind)
    return "\n".join(f"- ({h.get('kind')}) {h.get('name') or h['text'][:90]}"
                     f"  [score {h['score']:.2f}]" for h in hits) or "(no results)"


@tool
def get_person_facts(name: str) -> str:
    """Hard facts about a person: relationship, org, region, and message history."""
    kb = get_kb()
    p = kb.graph.find_person(name)
    if not p:
        return f"No person named {name}."
    rel = kb.retriever.relationships.get(name, {})
    return (f"{p.name}: {rel.get('type', 'contact')} at {p.org or rel.get('org', '—')}; "
            f"region {p.region or '—'}{' (regional)' if p.regional else ''}. "
            f"{rel.get('note', '')}")


@tool
def asana_create_task(name: str, notes: str = "", project: str = "1201000000000001") -> str:
    """Create an Asana task. Returns the new task gid."""
    t = get_asana().create_task(name=name, notes=notes, project=project)
    return f"created task {t.gid}: {t.name}"


@tool
def asana_update_task(gid: str, notes: str) -> str:
    """Update an existing Asana task's notes/status."""
    t = get_asana().update_task(gid, notes=notes)
    return f"updated task {t.gid}"


@tool
def asana_complete_task(gid: str) -> str:
    """Mark an Asana task complete."""
    return f"completed {get_asana().complete_task(gid).gid}"


@tool
def asana_comment(gid: str, text: str) -> str:
    """Add a comment to an Asana task."""
    c = get_asana().add_comment(gid, text)
    return f"commented on {gid}: {c.gid}"


@tool
def asana_create_milestone(name: str, project: str, due_on: str = "") -> str:
    """Create an Asana milestone (a task flagged as a milestone)."""
    m = get_asana().create_milestone(name=name, project=project, due_on=due_on or None)
    return f"created milestone {m.gid}: {m.name}"


# ---- channel send tools (gated: only used after human approval) -------------
@tool
def gmail_send_reply(thread_id: str, text: str, to: str = "") -> str:
    """Send an email reply on Gmail. Gated behind approval."""
    r = get_connectors()["gmail"].send_reply(thread_id, text, to=to or None)
    return f"gmail sent: {r.get('id')}"


@tool
def x_reply(in_reply_to_tweet_id: str, text: str) -> str:
    """Post a reply on X (Twitter). Gated behind approval."""
    r = get_connectors()["x"].send_reply(in_reply_to_tweet_id, text)
    return f"x posted: {r.get('id')}"


@tool
def whatsapp_send(to: str, text: str) -> str:
    """Send a WhatsApp message. Gated behind approval."""
    r = get_connectors()["whatsapp"].send_reply(to, text, to=to)
    return f"whatsapp sent: {r['messages'][0]['id']}"


READ_TOOLS = [vector_search, get_person_facts]
ASANA_TOOLS = [asana_create_task, asana_update_task, asana_complete_task, asana_comment,
               asana_create_milestone]
SEND_TOOLS = [gmail_send_reply, x_reply, whatsapp_send]
ALL_TOOLS = READ_TOOLS + ASANA_TOOLS + SEND_TOOLS

# channel -> its send tool, for the executor/approval path
SEND_BY_CHANNEL = {"gmail": gmail_send_reply, "x": x_reply, "whatsapp": whatsapp_send}

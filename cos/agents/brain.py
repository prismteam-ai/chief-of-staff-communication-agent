"""The Chief of Staff brain — a LangGraph pipeline of role agents.

Flow:  retrieve (RAG) → triage → decide → { draft | delegate | skip } → execute → assemble

RAG is injected at every reasoning step: the hard facts + related tasks + cross-channel +
preferences + org facts from `kb.retriever.context_pack` go into the triage, decide, and draft
prompts. The draft node also conditions on the learned StyleProfile so replies match the
owner's voice. Delegated actions hand off to A2A role agents (wired in a2a/; stubbed until then).
"""

from __future__ import annotations

from operator import add
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from cos.agents import style
from cos.agents.contracts import AgentResult, Delegation, Triage
from cos.agents.llm import structured
from cos.agents.roles import ACTION_TO_ROLE
from cos.agents.runtime import get_kb
from cos.kb.ontology import Action, AsanaOp, Draft, Recommendation
from cos.models import Message

DRAFT_ACTIONS = {Action.REPLY, Action.ASK_SENDER, Action.DECLINE, Action.ACKNOWLEDGE,
                 Action.FOLLOW_UP, Action.INTRODUCE}
DELEGATE_ACTIONS = set(ACTION_TO_ROLE)   # ESCALATE, FORWARD, DELEGATE, SCHEDULE_MEETING

TAXONOMY = (
    "REPLY: draft+send a reply | ASK_SENDER: reply asking the sender to clarify | "
    "SCHEDULE_MEETING: they want a call | ESCALATE: urgent/above the line, route to a teammate | "
    "DELEGATE: someone else should own it | NEEDS_INPUT: ask the exec before acting | "
    "NO_ACTION: FYI/handled | FORWARD: send to the right person | INTRODUCE: make an intro | "
    "FOLLOW_UP: chase an unanswered thread | DECLINE: polite no | ACKNOWLEDGE: quick ack | "
    "FLAG_SPAM: junk. Asana ops: CREATE_TASK, UPDATE_TASK, COMPLETE_TASK, COMMENT_ON_TASK, "
    "COMMENT_ON_MILESTONE, COMPLETE_MILESTONE, DELETE_TASK, NONE.")


class CoSState(TypedDict, total=False):
    message: Message
    dry_run: bool
    context: object
    triage: Triage
    recommendation: Recommendation
    draft: Draft | None
    delegation: Delegation | None
    executed_ops: list[str]
    result: AgentResult
    trace: Annotated[list[str], add]


def _facts(pack) -> str:
    return "\n".join(f"- {f}" for f in pack.facts) or "(none)"


def _context(pack) -> str:
    tasks = "\n".join(f"- {t.name} ({'milestone' if t.is_milestone else 'task'}"
                      f"{', due ' + t.due_on if t.due_on else ''}, gid {t.gid})"
                      for t in pack.related_tasks) or "(none)"
    cc = "\n".join(f"- [{x.channel.value}] {x.body[:80]}" for x in pack.cross_channel) or "(none)"
    prefs = "\n".join(f"- {p}" for p in pack.preferences) or "(none)"
    org = "\n".join(f"- {o}" for o in pack.org_facts) or "(none)"
    return (f"HARD FACTS:\n{_facts(pack)}\n\nRELATED ASANA:\n{tasks}\n\n"
            f"CROSS-CHANNEL:\n{cc}\n\nPREFERENCES:\n{prefs}\n\nORG KNOWLEDGE:\n{org}")


# ---- nodes ------------------------------------------------------------------
def n_retrieve(state: CoSState) -> dict:
    m = state["message"]
    pack = get_kb().retriever.context_pack(m)
    return {"context": pack,
            "trace": [f"RAG: {len(pack.facts)} facts, {len(pack.related_tasks)} tasks, "
                      f"{len(pack.cross_channel)} cross-channel"]}


def n_triage(state: CoSState) -> dict:
    m, pack = state["message"], state["context"]
    t = structured(Triage).invoke(
        f"You are the chief of staff. Triage this {m.channel.value} message.\n\n"
        f"FROM: {m.sender.name}\nMESSAGE: {m.body}\n\nHARD FACTS:\n{_facts(pack)}\n\n"
        "Return priority, whether it needs a reply, any deadline, whether it is confidential.")
    return {"triage": t, "trace": [f"triage: {t.priority.value}, needs_reply={t.needs_reply}"]}


def n_decide(state: CoSState) -> dict:
    m, pack, t = state["message"], state["context"], state["triage"]
    rec = structured(Recommendation).invoke(
        "You are the chief of staff. Decide the single best communication action and optional "
        f"Asana op for this message, grounded in the facts.\n\nTAXONOMY: {TAXONOMY}\n\n"
        "DECISION RULES:\n"
        "- Prefer REPLY when the executive can respond directly — even just to acknowledge and "
        "commit to a next step. Most messages are REPLY.\n"
        "- Use NEEDS_INPUT ONLY when a real decision requires the executive AND you cannot draft "
        "any reasonable reply. An investor asking a question you can acknowledge is still REPLY.\n"
        "- Use ESCALATE / FORWARD / DELEGATE ONLY when the message is truly someone else's to "
        "handle (outage → engineering, tax/invoice → CFO). NOT for the executive's own work "
        "(e.g. filling a board slide is the exec's task → REPLY).\n"
        "- SCHEDULE_MEETING for meeting requests, DECLINE to politely refuse, FLAG_SPAM for junk, "
        "NO_ACTION for FYI/handled, FOLLOW_UP to chase an unanswered thread.\n"
        "ASANA RULES:\n"
        "- If a RELATED ASANA item already covers this, use UPDATE_TASK to progress it (preferred) "
        "or COMMENT to log a decision. If it needs NEW follow-up not yet tracked, use CREATE_TASK. "
        "Use COMPLETE_* only when the work is done, DELETE_TASK when it's cancelled. Otherwise "
        "NONE. Do not add an Asana op just because you can.\n\n"
        f"FROM: {m.sender.name} on {m.channel.value}\nMESSAGE: {m.body}\n\n"
        f"TRIAGE: priority={t.priority.value}, confidential={t.confidential}\n\n"
        f"{_context(pack)}\n\n"
        "Pick action + asana_op + priority + target (a teammate for escalate/forward/delegate) "
        "+ a one-line rationale. Respect policy facts (e.g. do not disclose Series A terms).")
    rec.message_id = m.id
    return {"recommendation": rec,
            "trace": [f"decide: {rec.action.value} + {rec.asana_op.value}"
                      f"{' → ' + rec.target if rec.target else ''}"]}


def route(state: CoSState) -> str:
    a = state["recommendation"].action
    if a in DELEGATE_ACTIONS:
        return "delegate"
    if a in DRAFT_ACTIONS:
        return "draft"
    return "execute"


def n_draft(state: CoSState) -> dict:
    m, pack = state["message"], state["context"]
    profile, few = style.style_pack(get_kb(), m)
    d = structured(Draft).invoke(
        "Write the executive's reply in THEIR voice. Match this style profile exactly.\n\n"
        f"STYLE: tone={profile.tone}; formality={profile.formality}; signoff={profile.signoff}; "
        f"emoji={profile.uses_emoji}; rules={profile.rules}\n"
        f"THEIR PAST MESSAGES (match this voice):\n" + "\n".join(f"- {x}" for x in few) +
        f"\n\nINCOMING from {m.sender.name} on {m.channel.value}: {m.body}\n\n"
        f"{_context(pack)}\n\n"
        "Draft a concise reply grounded in the facts. Do not disclose confidential terms. "
        "No em dashes.")
    d.message_id = m.id
    sc = style.style_score(get_kb(), d.text)
    return {"draft": d, "trace": [f"draft: {len(d.text.split())} words, style_score={sc}"]}


def n_delegate(state: CoSState) -> dict:
    rec, m = state["recommendation"], state["message"]
    role = ACTION_TO_ROLE.get(rec.action, "chief_of_staff")
    deleg = Delegation(role=role, summary=(rec.rationale or m.body[:100]),
                       reason=rec.rationale or "", status="pending")
    # A2A round-trip is wired in cos/agents/a2a; brain.set_delegator installs it.
    if _DELEGATOR is not None:
        deleg = _DELEGATOR(role, m, deleg)
    return {"delegation": deleg, "trace": [f"delegate → {role} ({deleg.status})"]}


def n_execute(state: CoSState) -> dict:
    rec = state["recommendation"]
    ops: list[str] = []
    if rec.asana_op is not AsanaOp.NONE:
        if state.get("dry_run", True):
            ops.append(f"[dry-run] {rec.asana_op.value}")
        else:
            ops.append(_execute_asana(rec, state["context"]))
    return {"executed_ops": ops, "trace": [f"execute: {ops or 'no-op'}"]}


def n_assemble(state: CoSState) -> dict:
    m, pack = state["message"], state["context"]
    return {"result": AgentResult(
        message_id=m.id, recommendation=state["recommendation"],
        draft=state.get("draft"), delegation=state.get("delegation"),
        executed_ops=state.get("executed_ops", []), facts_used=pack.facts,
        trace=state["trace"])}


# ---- real Asana execution (non-dry-run) -------------------------------------
def _execute_asana(rec: Recommendation, pack) -> str:
    from cos.agents.runtime import get_asana
    a = get_asana()
    top = pack.related_tasks[0] if pack.related_tasks else None
    op = rec.asana_op
    try:
        if op is AsanaOp.CREATE_TASK:
            return f"created {a.create_task(name=rec.rationale[:60] or 'Follow-up').gid}"
        if top and op in (AsanaOp.UPDATE_TASK,):
            return f"updated {a.update_task(top.gid, notes=rec.rationale[:120]).gid}"
        if top and op in (AsanaOp.COMPLETE_TASK, AsanaOp.COMPLETE_MILESTONE):
            return f"completed {a.complete_task(top.gid).gid}"
        if top and op in (AsanaOp.COMMENT_ON_TASK, AsanaOp.COMMENT_ON_MILESTONE):
            return f"commented {a.add_comment(top.gid, rec.rationale[:120]).gid}"
        if top and op is AsanaOp.DELETE_TASK:
            a.delete_task(top.gid)
            return f"deleted {top.gid}"
    except Exception as e:  # noqa: BLE001 — surface, don't crash the pipeline
        return f"asana error: {e}"
    return f"{op.value} (no target task)"


# delegation hook (installed by cos.agents.a2a.client)
_DELEGATOR = None


def set_delegator(fn) -> None:
    global _DELEGATOR
    _DELEGATOR = fn


# ---- graph ------------------------------------------------------------------
def _build():
    g = StateGraph(CoSState)
    g.add_node("retrieve", n_retrieve)
    g.add_node("triage", n_triage)
    g.add_node("decide", n_decide)
    g.add_node("draft", n_draft)
    g.add_node("delegate", n_delegate)
    g.add_node("execute", n_execute)
    g.add_node("assemble", n_assemble)
    g.add_edge(START, "retrieve")
    g.add_edge("retrieve", "triage")
    g.add_edge("triage", "decide")
    g.add_conditional_edges("decide", route,
                            {"draft": "draft", "delegate": "delegate", "execute": "execute"})
    g.add_edge("draft", "execute")
    g.add_edge("delegate", "execute")
    g.add_edge("execute", "assemble")
    g.add_edge("assemble", END)
    return g.compile()


_APP = None


def _app():
    global _APP
    if _APP is None:
        _APP = _build()
    return _APP


def run(message: Message, dry_run: bool = True) -> AgentResult:
    out = _app().invoke({"message": message, "dry_run": dry_run, "trace": []})
    return out["result"]


def _events_for(node: str, delta: dict):
    """Translate one graph node's state delta into UI events (thoughts / tool calls /
    actions). Object payloads (ContextPack, Triage, Recommendation, Draft, Delegation,
    AgentResult) are passed through raw; the API layer serializes them."""
    trace = (delta.get("trace") or [""])[-1]
    if node == "retrieve":
        pack = delta["context"]
        yield {"type": "tool_call", "name": "rag.context_pack",
               "result": {"facts": len(pack.facts), "tasks": len(pack.related_tasks),
                          "cross_channel": len(pack.cross_channel)}}
        yield {"type": "context", "context": pack}
        yield {"type": "thought", "step": "retrieve", "text": trace}
    elif node == "triage":
        yield {"type": "thought", "step": "triage", "text": trace,
               "triage": delta["triage"]}
    elif node == "decide":
        yield {"type": "action", "step": "decide", "text": trace,
               "recommendation": delta["recommendation"]}
    elif node == "draft":
        yield {"type": "draft", "step": "draft", "text": trace,
               "draft": delta["draft"]}
    elif node == "delegate":
        deleg = delta["delegation"]
        yield {"type": "tool_call", "name": f"a2a.delegate.{deleg.role}",
               "result": deleg.response, "delegation": deleg}
    elif node == "execute":
        ops = delta.get("executed_ops") or []
        if ops:
            yield {"type": "tool_call", "name": "asana.execute", "result": ops}
        yield {"type": "thought", "step": "execute", "text": trace}
    elif node == "assemble":
        yield {"type": "result", "result": delta["result"]}


def stream(message: Message, dry_run: bool = True):
    """Yield the brain's work step-by-step: one or more events per graph node, ending
    with a ``result`` event carrying the full AgentResult. Faithful to what the pipeline
    actually does — no fabricated tool loop."""
    for update in _app().stream(
            {"message": message, "dry_run": dry_run, "trace": []}, stream_mode="updates"):
        for node, delta in update.items():
            yield from _events_for(node, delta)

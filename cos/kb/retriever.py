"""Hybrid retriever: graph neighbors + vector matches → a ContextPack per message.

Also does cross-channel linking (same person + similar content) and message→task linking
(vector over task text), the two hybrid jobs the ontology calls for.
"""

from __future__ import annotations

import re

from cos.kb.graph import KnowledgeGraph
from cos.kb.ontology import ContextPack
from cos.kb.vector import VectorIndex
from cos.models import Message, Task


# Detects a deadline phrase in a message so it can be surfaced as a hard fact.
DEADLINE_RE = re.compile(
    r"\b(?:by\s+(?:end of week|eod|"
    r"mon|tues|wednes|thurs|fri|satur|sun)day"           # by <weekday>
    r"|by\s+the\s+\d{1,2}(?:st|nd|rd|th)?"                 # by the 15th
    r"|by\s+end of week|end of week|by\s+eod|eod"          # by end of week / eod
    r"|this week|next week)\b")


class HybridRetriever:
    def __init__(self, graph: KnowledgeGraph, vector: VectorIndex,
                 company: dict | None = None, relationships: dict | None = None) -> None:
        self.g = graph
        self.v = vector
        self.company = company or {}
        self.relationships = relationships or {}
        self._task_by_gid = {t.gid: t for t in graph.tasks}

    # ---- message -> linked tasks (hybrid) -----------------------------------
    def related_tasks(self, m: Message, k: int = 3) -> list[Task]:
        hits = self.v.search(f"{m.subject or ''} {m.body}", k=k, kind="task")
        return [self._task_by_gid[h["gid"]] for h in hits if h["gid"] in self._task_by_gid]

    def top_task(self, m: Message) -> Task | None:
        tasks = self.related_tasks(m, k=1)
        return tasks[0] if tasks else None

    # ---- cross-channel linking ---------------------------------------------
    def cross_channel(self, m: Message) -> list[Message]:
        """Same person, other channels — resolved deterministically via the graph's
        identity edges (email / @handle / phone → one Person). This is precise; content
        similarity is only a fallback for linking messages with no shared identity."""
        pid = self.g.person_id_for(m)
        if not pid:
            return []
        return [o for o in self.g.messages_by_person(pid)
                if o.channel != m.channel and o.id != m.id]

    def similar_messages(self, m: Message, k: int = 3) -> list[dict]:
        """Vector fallback: semantically related messages regardless of sender."""
        return self.v.search(f"{m.subject or ''} {m.body}", k=k, kind="message")

    # ---- hard facts (deterministic, authoritative) --------------------------
    def facts(self, m: Message) -> list[str]:
        """Precise statements the brain can trust — from the graph, Asana, company data,
        and policy — as opposed to the fuzzy retrieved context."""
        out: list[str] = []
        p = self.g.person_for(m)
        rel = self.relationships.get(p.name, {}) if p else {}
        typ = rel.get("type", "contact")

        if p:
            org = p.org or rel.get("org") or ""
            line = f"Sender: {p.name} — {typ}" + (f" at {org}" if org else "")
            if rel.get("note"):
                line += f". {rel['note']}"
            out.append(line)
            if p.regional:
                out.append(f"{p.name} is a regional contact ({p.region}).")
            pid = self.g.person_id_for(m)
            hist = [x for x in self.g.messages_by_person(pid) if x.thread_id != m.thread_id]
            threads = {(x.channel.value, x.thread_id) for x in hist}
            if threads:
                since = min(x.timestamp for x in hist).date()
                out.append(f"Prior history: {len(threads)} earlier thread(s), "
                           f"first contact {since}.")
            else:
                out.append(f"No prior history with {p.name} — first contact.")

        cc = self.cross_channel(m)
        if cc:
            chans = ", ".join(sorted({x.channel.value for x in cc}))
            out.append(f"Same person is also active on: {chans}.")

        dl = DEADLINE_RE.search(f"{m.subject or ''} {m.body}".lower())
        if dl:
            out.append(f"Deadline referenced in the message: \"{dl.group(0)}\".")

        top = self.top_task(m)
        if top:
            kind = "milestone" if top.is_milestone else "task"
            due = f", due {top.due_on}" if top.due_on else ""
            state = "done" if top.completed else "open"
            out.append(f"Linked Asana {kind}: '{top.name}' ({state}{due}).")

        fr = self.company.get("fundraise", {})
        if typ == "investor" and fr:
            out.append(f"Company is closing a {fr.get('round')} "
                       f"(target {fr.get('target_close')}).")
            if fr.get("confidential"):
                out.append("POLICY: do not disclose Series A terms, valuation, or "
                           "investor names.")
        if typ == "press":
            out.append("POLICY: decline press/podcasts during the active raise; defer politely.")
        if typ == "customer":
            out.append("POLICY: customer escalations route to Victor Ruiz (Head of Engineering).")
        return out

    # ---- full context pack --------------------------------------------------
    def context_pack(self, m: Message) -> ContextPack:
        pid = self.g.person_id_for(m)
        thread = [x for x in self.g.thread_messages(m.channel.value, m.thread_id)
                  if x.id != m.id]
        sender_hist = [x for x in (self.g.messages_by_person(pid) if pid else [])
                       if x.thread_id != m.thread_id]
        q = f"{m.subject or ''} {m.body}"
        return ContextPack(
            message=m,
            facts=self.facts(m),
            thread_history=thread,
            sender_history=sender_hist,
            related_tasks=self.related_tasks(m),
            cross_channel=self.cross_channel(m),
            style_examples=[h["text"] for h in self.v.search(q, k=3, kind="style")],
            preferences=[h["text"] for h in self.v.search(q, k=3, kind="pref")],
            org_facts=[h["text"] for h in self.v.search(q, k=3, kind="orgfact")],
        )

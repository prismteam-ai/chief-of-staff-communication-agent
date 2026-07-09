"""The knowledge graph: entities + edges, pure structure (no embeddings).

Builds Person/Message/Thread/Task nodes and the edges from ONTOLOGY.md, resolves
cross-channel identity, and answers the relationship queries the eval methods need.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta

from cos.models import Direction, Message, Project, Task


@dataclass
class Person:
    id: str
    name: str
    org: str | None = None
    region: str | None = None
    regional: bool = False
    is_owner: bool = False
    is_team: bool = False
    role: str | None = None


def _norm(value: str | None) -> str:
    return (value or "").lower().lstrip("@+ ").strip()


class KnowledgeGraph:
    def __init__(self) -> None:
        self.persons: dict[str, Person] = {}
        self.identity_index: dict[str, str] = {}      # normalized identity -> person_id
        self.messages: list[Message] = []
        self.by_person: dict[str, list[Message]] = defaultdict(list)
        self.threads: dict[tuple[str, str], list[Message]] = defaultdict(list)
        self.tasks: list[Task] = []
        self.projects: list[Project] = []

    # ---- build --------------------------------------------------------------
    def add_person(self, p: Person, identities: list[str]) -> None:
        self.persons[p.id] = p
        for ident in identities:
            if ident:
                self.identity_index[_norm(ident)] = p.id

    def add_message(self, m: Message) -> None:
        self.messages.append(m)
        self.threads[(m.channel.value, m.thread_id)].append(m)
        pid = self.person_id_for(m)
        if pid:
            self.by_person[pid].append(m)

    def add_tasks(self, tasks: list[Task]) -> None:
        self.tasks = tasks

    def add_projects(self, projects: list[Project]) -> None:
        self.projects = projects

    # ---- identity -----------------------------------------------------------
    def person_id_for(self, m: Message) -> str | None:
        for cand in (m.sender.email, m.sender.handle, m.sender.id):
            pid = self.identity_index.get(_norm(cand))
            if pid:
                return pid
        return None

    def person_for(self, m: Message) -> Person | None:
        pid = self.person_id_for(m)
        return self.persons.get(pid) if pid else None

    def find_person(self, name: str) -> Person | None:
        return next((p for p in self.persons.values() if p.name == name), None)

    # ---- relationship queries ----------------------------------------------
    def thread_messages(self, channel: str, thread_id: str) -> list[Message]:
        return sorted(self.threads[(channel, thread_id)], key=lambda x: x.timestamp)

    def messages_by_person(self, person_id: str) -> list[Message]:
        return sorted(self.by_person.get(person_id, []), key=lambda x: x.timestamp)

    def awaiting_threads(self) -> list[list[Message]]:
        """Threads whose latest message is incoming — the exec owes a reply."""
        out = []
        for msgs in self.threads.values():
            ordered = sorted(msgs, key=lambda x: x.timestamp)
            if ordered[-1].direction is Direction.incoming:
                out.append(ordered)
        return out

    def stale_outbound(self) -> list[list[Message]]:
        """Threads the exec started with no reply back — candidates for follow-up."""
        out = []
        for msgs in self.threads.values():
            if msgs and all(x.direction is Direction.outgoing for x in msgs):
                out.append(sorted(msgs, key=lambda x: x.timestamp))
        return out

    def milestones(self) -> list[Task]:
        return [t for t in self.tasks if t.is_milestone]

    def now(self):
        return max((m.timestamp for m in self.messages), default=None)

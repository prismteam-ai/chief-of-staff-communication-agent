"""Role registry — personas + tool permission boundaries.

Roles come from the org ontology (the team in scenario.json) plus the Chief of Staff. Each
role's allowed tools are its permission boundary (the graded access-boundary dimension): the
drafter can read + send but not mutate Asana; the Asana executor can mutate Asana but not send;
role specialists (engineering/cfo/recruiter/scheduler) are the A2A delegation targets.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from cos.agents import tools
from cos.kb.ontology import Action


@dataclass
class Role:
    name: str
    persona: str
    tool_names: list[str] = field(default_factory=list)
    handles: list[Action] = field(default_factory=list)

    def toolset(self):
        return [t for t in tools.ALL_TOOLS if t.name in self.tool_names]


ROLES: dict[str, Role] = {
    "chief_of_staff": Role(
        "chief_of_staff",
        "The executive's chief of staff. Triages every message, decides the next action, and "
        "coordinates specialists. Never sends without approval.",
        [t.name for t in tools.READ_TOOLS]),
    "drafter": Role(
        "drafter",
        "Writes replies in the executive's voice. Read + send only; no Asana mutation.",
        [t.name for t in tools.READ_TOOLS + tools.SEND_TOOLS]),
    "asana": Role(
        "asana",
        "Manages Asana work items. Can mutate Asana; cannot send messages.",
        [t.name for t in tools.READ_TOOLS + tools.ASANA_TOOLS]),
    # A2A specialist roles (map to the internal team)
    "engineering": Role(
        "engineering",
        "Victor Ruiz, Head of Engineering. Owns outages/SEV. Triages incidents and gives an ETA.",
        [t.name for t in tools.READ_TOOLS + tools.ASANA_TOOLS],
        [Action.ESCALATE]),
    "cfo": Role(
        "cfo",
        "Nadia Cohen, CFO. Owns finance, tax, invoices.",
        [t.name for t in tools.READ_TOOLS], [Action.FORWARD]),
    "recruiter": Role(
        "recruiter",
        "Mia Anders, Recruiter. Owns hiring logistics and candidate scheduling.",
        [t.name for t in tools.READ_TOOLS + tools.ASANA_TOOLS], [Action.DELEGATE]),
    "scheduler": Role(
        "scheduler",
        "Scheduling assistant. Proposes meeting times.",
        [t.name for t in tools.READ_TOOLS], [Action.SCHEDULE_MEETING]),
}

# which specialist role handles each delegated action
ACTION_TO_ROLE = {
    Action.ESCALATE: "engineering",
    Action.FORWARD: "cfo",
    Action.DELEGATE: "recruiter",
    Action.SCHEDULE_MEETING: "scheduler",
}

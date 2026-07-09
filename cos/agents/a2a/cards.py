"""Agent cards for the A2A role agents (derived from the role registry)."""

from __future__ import annotations

from cos.agents.a2a.protocol import AgentCard, AgentSkill
from cos.agents.roles import ROLES

# role -> default local port
ROLE_PORTS = {"engineering": 8901, "cfo": 8902, "recruiter": 8903, "scheduler": 8904}


def card_for(role_name: str, url: str) -> AgentCard:
    role = ROLES[role_name]
    skill = AgentSkill(
        id=f"{role_name}.handle",
        name=f"{role_name} handling",
        description=role.persona,
        tags=[a.value for a in role.handles] or [role_name])
    return AgentCard(name=role_name, description=role.persona, url=url, skills=[skill])

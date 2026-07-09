"""Ontology types not already in cos.models.

The action taxonomy mirrors docs/PRD.md; the entities mirror docs/ONTOLOGY.md. The graph
holds these plus the reused Message/Task/Project/Comment from cos.models.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from cos.models import Message, Task


# ---- action taxonomy (PRD §3) -----------------------------------------------
class Action(str, Enum):
    REPLY = "REPLY"
    ASK_SENDER = "ASK_SENDER"
    SCHEDULE_MEETING = "SCHEDULE_MEETING"
    ESCALATE = "ESCALATE"
    DELEGATE = "DELEGATE"
    NEEDS_INPUT = "NEEDS_INPUT"
    NO_ACTION = "NO_ACTION"
    FORWARD = "FORWARD"
    INTRODUCE = "INTRODUCE"
    FOLLOW_UP = "FOLLOW_UP"
    DECLINE = "DECLINE"
    ACKNOWLEDGE = "ACKNOWLEDGE"
    FLAG_SPAM = "FLAG_SPAM"


class AsanaOp(str, Enum):
    CREATE_TASK = "CREATE_TASK"
    UPDATE_TASK = "UPDATE_TASK"
    COMPLETE_TASK = "COMPLETE_TASK"
    COMMENT_ON_TASK = "COMMENT_ON_TASK"
    COMMENT_ON_MILESTONE = "COMMENT_ON_MILESTONE"
    COMPLETE_MILESTONE = "COMPLETE_MILESTONE"
    DELETE_TASK = "DELETE_TASK"
    NONE = "NONE"


class Priority(str, Enum):
    urgent = "urgent"
    high = "high"
    medium = "medium"
    low = "low"


# ---- entities ---------------------------------------------------------------
class Identity(BaseModel):
    value: str        # email / @handle / phone
    channel: str
    person_id: str


class Topic(BaseModel):
    key: str
    title: str = ""
    thread_ids: list[str] = Field(default_factory=list)


class Preference(BaseModel):
    key: str
    value: str


class OrgFact(BaseModel):
    text: str
    source: str = ""


class Recommendation(BaseModel):
    message_id: str
    action: Action
    asana_op: AsanaOp = AsanaOp.NONE
    priority: Priority = Priority.medium
    confidence: float = 0.0
    rationale: str = ""
    target: str | None = None          # team member for escalate/forward/delegate/assign


class Draft(BaseModel):
    message_id: str
    text: str
    in_style_of: str = "owner"


# ---- retrieval contract (ONTOLOGY.md §Retrieval) ----------------------------
class ContextPack(BaseModel):
    """Everything the brain gets for one incoming message."""

    message: Message
    facts: list[str] = Field(default_factory=list)   # hard, authoritative statements
    thread_history: list[Message] = Field(default_factory=list)
    sender_history: list[Message] = Field(default_factory=list)
    related_tasks: list[Task] = Field(default_factory=list)
    cross_channel: list[Message] = Field(default_factory=list)
    style_examples: list[str] = Field(default_factory=list)
    preferences: list[str] = Field(default_factory=list)
    org_facts: list[str] = Field(default_factory=list)

"""Normalized internal data model.

Every connector maps its provider's native payload into these shapes, so the rest of the
system (RAG, drafting, dashboard) never sees provider-specific formats.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class Channel(str, Enum):
    gmail = "gmail"
    x = "x"
    whatsapp = "whatsapp"


class Direction(str, Enum):
    incoming = "incoming"
    outgoing = "outgoing"


class Participant(BaseModel):
    id: str
    name: str
    handle: str | None = None          # @handle, phone, or email depending on channel
    email: str | None = None
    org: str | None = None             # employer / company, when known
    is_regional: bool = False          # owner/contact located in the same region as the exec
    is_owner: bool = False             # the executive whose inbox this is


class Attachment(BaseModel):
    filename: str
    mime_type: str
    size_bytes: int = 0


class Message(BaseModel):
    id: str                            # stable internal id
    channel: Channel
    thread_id: str
    sender: Participant
    recipients: list[Participant] = Field(default_factory=list)
    timestamp: datetime
    subject: str | None = None
    body: str
    direction: Direction = Direction.incoming
    attachments: list[Attachment] = Field(default_factory=list)
    # provenance: how we got this record (provider + native id), for source-backed answers
    provenance: dict[str, str] = Field(default_factory=dict)
    # topic tag used to link the same conversation across channels
    topic: str | None = None


class Thread(BaseModel):
    id: str
    channel: Channel
    subject: str | None = None
    participant_ids: list[str] = Field(default_factory=list)
    message_ids: list[str] = Field(default_factory=list)
    topic: str | None = None
    answered: bool = False


class Project(BaseModel):
    gid: str
    name: str


class Task(BaseModel):
    """Normalized Asana task. A milestone is a task with ``is_milestone=True``
    (Asana models milestones as a task subtype)."""

    gid: str
    name: str
    notes: str = ""
    project_gids: list[str] = Field(default_factory=list)
    assignee: str | None = None
    due_on: str | None = None
    completed: bool = False
    is_milestone: bool = False
    # link back to the communication that spawned/updated this task
    linked_message_id: str | None = None
    permalink_url: str | None = None


class Comment(BaseModel):
    """An Asana story/comment on a task."""

    gid: str
    task_gid: str
    text: str
    created_by: str | None = None

"""A2A protocol types (Pydantic), shaped after the Agent2Agent spec.

Agent cards advertise a role agent at ``/.well-known/agent-card.json``; work is sent via a
JSON-RPC 2.0 ``message/send`` call that returns a Task with the agent's reply message.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentSkill(BaseModel):
    id: str
    name: str
    description: str
    tags: list[str] = Field(default_factory=list)


class AgentCapabilities(BaseModel):
    streaming: bool = False


class AgentCard(BaseModel):
    name: str
    description: str
    url: str
    version: str = "1.0"
    capabilities: AgentCapabilities = Field(default_factory=AgentCapabilities)
    default_input_modes: list[str] = Field(default_factory=lambda: ["text"])
    default_output_modes: list[str] = Field(default_factory=lambda: ["text"])
    skills: list[AgentSkill] = Field(default_factory=list)


class TextPart(BaseModel):
    type: str = "text"
    text: str


class A2AMessage(BaseModel):
    role: str  # "user" | "agent"
    parts: list[TextPart]

    @property
    def text(self) -> str:
        return " ".join(p.text for p in self.parts if p.type == "text")


class TaskStatus(BaseModel):
    state: str  # submitted | working | completed | failed


class A2ATask(BaseModel):
    id: str
    status: TaskStatus
    messages: list[A2AMessage] = Field(default_factory=list)


class JsonRpcRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int = 1
    method: str
    params: dict = Field(default_factory=dict)


class JsonRpcResponse(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int = 1
    result: dict | None = None
    error: dict | None = None

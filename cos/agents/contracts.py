"""Pydantic domain contracts for the multi-agent brain.

Every agent step and the judge return one of these validated objects (via
``with_structured_output``), so the pipeline is typed end-to-end. Reuses the action taxonomy
and Recommendation/Draft from cos.kb.ontology.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from cos.kb.ontology import Action, AsanaOp, Draft, Priority, Recommendation


# ---- style ------------------------------------------------------------------
class StyleProfile(BaseModel):
    """Learned from the owner's sent messages + declared preferences."""

    tone: str = Field(description="e.g. warm, direct, concise")
    formality: str = Field(description="casual | neutral | formal")
    signoff: str = Field(description="how the owner signs off, or 'none'")
    uses_emoji: bool = False
    avg_sentence_words: int = 14
    rules: list[str] = Field(default_factory=list,
                             description="explicit do/don't rules, e.g. 'no em dashes'")
    examples: list[str] = Field(default_factory=list,
                                description="short verbatim style exemplars")


# ---- agent step outputs -----------------------------------------------------
class Triage(BaseModel):
    priority: Priority
    needs_reply: bool
    deadline: str | None = Field(None, description="deadline phrase if any")
    confidential: bool = Field(False, description="touches sensitive info (e.g. raise terms)")
    reason: str = ""


class Delegation(BaseModel):
    role: str = Field(description="team role to hand off to: engineering|cfo|recruiter|scheduler")
    summary: str = Field(description="what the specialist should do")
    reason: str = ""
    # filled after the A2A round-trip
    status: str = "pending"
    response: str | None = None


class AgentResult(BaseModel):
    message_id: str
    recommendation: Recommendation
    draft: Draft | None = None
    delegation: Delegation | None = None
    executed_ops: list[str] = Field(default_factory=list)
    facts_used: list[str] = Field(default_factory=list)
    trace: list[str] = Field(default_factory=list)


# ---- judge ------------------------------------------------------------------
class JudgeVerdict(BaseModel):
    action_correct: float = Field(ge=0, le=1)
    op_correct: float = Field(ge=0, le=1)
    delegation_correct: float = Field(ge=0, le=1)
    uses_facts: float = Field(ge=0, le=1, description="draft/decision grounded in hard facts")
    policy_ok: float = Field(ge=0, le=1, description="respected policy, e.g. no term disclosure")
    style_match: float = Field(ge=0, le=1)
    no_hallucination: float = Field(ge=0, le=1)
    overall: float = Field(ge=0, le=1)
    passed: bool
    rationale: str = ""


# handy re-exports
__all__ = ["StyleProfile", "Triage", "Delegation", "AgentResult", "JudgeVerdict",
           "Action", "AsanaOp", "Priority", "Recommendation", "Draft"]

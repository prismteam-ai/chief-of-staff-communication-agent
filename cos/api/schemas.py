"""Request bodies + JSON serialization for the API layer."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


# ---- request bodies ---------------------------------------------------------
class StreamRequest(BaseModel):
    """Run the agent on an existing inbox message, or on a custom one."""
    message_id: str | None = None
    sender: str | None = None
    channel: str | None = None       # gmail | x | whatsapp
    body: str | None = None
    dry_run: bool = True             # the stream never really sends; approval does


class ApproveRequest(BaseModel):
    """Approve a draft → real send + real Asana op."""
    message_id: str
    channel: str
    text: str                        # possibly edited by the exec
    to: str | None = None
    thread_id: str | None = None
    asana_op: str | None = None      # AsanaOp value, or None to skip
    # Seconds from opening the message (agent run) to approving it — the real live
    # time-to-answer. The client measures it; fixture timestamps are historical so a
    # server-side now()-received delta would be meaningless.
    interaction_seconds: float | None = None


class ConnectionUpdate(BaseModel):
    mode: str = "mock"               # mock | real
    # real-mode credentials (only the fields relevant to the provider are read)
    credentials: dict[str, str] = {}


class StyleUpdate(BaseModel):
    """Owner-authored style overrides, merged into the learned StyleProfile."""
    voice: str = ""
    signoff: str = ""
    rules: list[str] = []            # explicit do/don't rules, obeyed verbatim
    examples: list[str] = []         # canonical example messages (few-shot at draft time)


# ---- serialization ----------------------------------------------------------
def to_jsonable(obj: Any) -> Any:
    """Recursively convert pydantic models (and containers of them) to JSON-safe values."""
    if isinstance(obj, BaseModel):
        return obj.model_dump(mode="json")
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    return obj

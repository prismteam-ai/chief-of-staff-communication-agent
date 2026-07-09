"""Turn scenario.json labels into evaluable cases against a built KB."""

from __future__ import annotations

from dataclasses import dataclass

from cos.kb.build import KB
from cos.models import Message


@dataclass
class Case:
    key: str
    contact: str
    channels: list[str]
    action: str
    asana: str | None
    priority: str
    target: str | None
    milestone: str | None
    task: str | None
    hero: bool
    trigger: Message | None


def _resolve_trigger(kb: KB, contact: str, channels: list[str]) -> Message | None:
    primary = "gmail" if "gmail" in channels else (channels[0] if channels else "gmail")
    cands = [m for m in kb.messages
             if m.sender.name == contact and m.channel.value == primary]
    if not cands:
        cands = [m for m in kb.messages if m.sender.name == contact]
    return max(cands, key=lambda x: x.timestamp) if cands else None


def cases(kb: KB) -> list[Case]:
    out: list[Case] = []
    for s in kb.scenario["scenarios"]:
        if s["key"] == "stale-outbound":                 # always the unanswered outbound
            stale = kb.graph.stale_outbound()
            trigger = stale[0][-1] if stale else None
        else:
            trigger = _resolve_trigger(kb, s["contact"], s.get("channels", []))
        out.append(Case(
            key=s["key"], contact=s["contact"], channels=s.get("channels", []),
            action=s["action"], asana=s.get("asana"), priority=s.get("priority", "medium"),
            target=s.get("target"), milestone=s.get("milestone"), task=s.get("task"),
            hero=s.get("hero", False), trigger=trigger))
    return out


def gold_cross_channel(kb: KB) -> set[tuple[str, frozenset]]:
    """Expected cross-channel groups: (contact, {channels}) for multi-channel scenarios."""
    return {(s["contact"], frozenset(s["channels"]))
            for s in kb.scenario["scenarios"] if len(s.get("channels", [])) > 1}

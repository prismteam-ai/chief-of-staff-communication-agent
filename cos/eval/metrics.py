"""Scoring primitives for the harness (see docs/EVAL.md §Metrics)."""

from __future__ import annotations

import re

_STOP = {"with", "your", "from", "this", "that", "the", "and", "for"}


def token_overlap(a: str, b: str) -> bool:
    """True if two names share a salient token — used to match a retrieved work item to
    the labeled one (the labeled milestone and its sibling task both count as 'this matter')."""
    def toks(s: str) -> set:
        return {w for w in re.findall(r"[a-z0-9]+", s.lower())
                if len(w) >= 4 and w not in _STOP}
    return bool(toks(a) & toks(b))


def accuracy(pairs: list[tuple]) -> tuple[int, int]:
    """pairs of (predicted, expected) -> (correct, total)."""
    correct = sum(1 for p, e in pairs if p == e)
    return correct, len(pairs)


def prf(pred: set, gold: set) -> tuple[float, float, float]:
    """precision, recall, F1 for two sets."""
    if not pred and not gold:
        return 1.0, 1.0, 1.0
    tp = len(pred & gold)
    p = tp / len(pred) if pred else 0.0
    r = tp / len(gold) if gold else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f1


def recall_at(found: set, expected: set) -> float:
    if not expected:
        return 1.0
    return len(found & expected) / len(expected)


# Asana-op families so a milestone-comment counts as the "comment" family, etc.
_OP_FAMILY = {
    "CREATE_TASK": "create", "UPDATE_TASK": "update",
    "COMPLETE_TASK": "complete", "COMPLETE_MILESTONE": "complete",
    "COMMENT_ON_TASK": "comment", "COMMENT_ON_MILESTONE": "comment",
    "DELETE_TASK": "delete", "NONE": "none", None: "none",
}


def op_family(op: str | None) -> str:
    return _OP_FAMILY.get(op, str(op).lower())

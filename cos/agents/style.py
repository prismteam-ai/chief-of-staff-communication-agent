"""Learn and match the owner's writing style.

`learn_style` distills the owner's sent messages (the RAG style corpus) into an explicit
`StyleProfile` via the LLM, merged with declared preferences. `style_pack` returns that profile
plus the nearest sent messages (RAG few-shot) for a given incoming message. `style_score` is a
deterministic, keyless metric: embedding cosine to the owner's style centroid blended with rule
checks (e.g. no em dashes).
"""

from __future__ import annotations

import hashlib

import numpy as np

from cos.agents.contracts import StyleProfile
from cos.fixtures import DATA_DIR

_CACHE: dict[str, StyleProfile] = {}


def invalidate_cache() -> None:
    """Drop learned profiles (call after the owner edits their style overrides)."""
    _CACHE.clear()


def _prefs_text() -> str:
    # Voice/sign-off come from the owner's editable overrides, which are seeded from the
    # legacy preferences.json the first time (see cos.kb.style_store).
    from cos.kb.style_store import load_overrides
    ov = load_overrides()
    return " ".join(v for v in (ov.get("voice"), ov.get("signoff")) if v)


def _dedup(*lists: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for lst in lists:
        for x in lst:
            k = x.strip()
            if k and k.lower() not in seen:
                seen.add(k.lower())
                out.append(k)
    return out


def learn_style(sent_texts: list[str], prefs: str | None = None) -> StyleProfile:
    from cos.kb.style_store import load_overrides
    ov = load_overrides()
    prefs = prefs if prefs is not None else _prefs_text()
    own_rules, own_examples = ov.get("rules") or [], ov.get("examples") or []

    key = hashlib.sha1(
        ("||".join(sent_texts) + prefs + "|R|".join(own_rules) + "|E|".join(own_examples)
         ).encode()).hexdigest()
    if key in _CACHE:
        return _CACHE[key]

    from cos.agents.llm import structured
    sample = "\n".join(f"- {t}" for t in sent_texts[:15])
    pinned_rules = ("\nRules the owner explicitly requires (obey verbatim):\n"
                    + "\n".join(f"- {r}" for r in own_rules)) if own_rules else ""
    pinned_ex = ("\nExample messages the owner provided as canonical voice:\n"
                 + "\n".join(f"- {e}" for e in own_examples)) if own_examples else ""
    prompt = (
        "You are analyzing an executive's writing style from messages they sent.\n"
        f"Declared preferences: {prefs}\n{pinned_rules}{pinned_ex}\n\n"
        f"Sent messages:\n{sample}\n\n"
        "Produce a StyleProfile capturing their tone, formality, sign-off, emoji use, typical "
        "sentence length, explicit do/don't rules, and 3-5 short verbatim exemplars. "
        "Respect the declared preferences and any explicitly required rules.")
    profile = structured(StyleProfile).invoke(prompt)

    # Owner-authored rules/examples are authoritative: fold them in and keep them first.
    profile.rules = _dedup(own_rules, profile.rules)
    profile.examples = _dedup(own_examples, profile.examples)
    _CACHE[key] = profile
    return profile


def owner_style_profile(kb) -> StyleProfile:
    from cos.kb.build import _owner_style_texts
    return learn_style(_owner_style_texts())


def style_centroid(kb) -> np.ndarray:
    vecs = [kb.vector._matrix[i] for i, m in enumerate(kb.vector.metas)
            if m.get("kind") == "style"]
    if not vecs:
        return np.zeros(kb.vector._matrix.shape[1] if kb.vector._matrix is not None else 1)
    c = np.mean(vecs, axis=0)
    n = np.linalg.norm(c)
    return c / n if n else c


def style_pack(kb, message) -> tuple[StyleProfile, list[str]]:
    from cos.kb.style_store import load_overrides
    profile = owner_style_profile(kb)
    q = f"{message.subject or ''} {message.body}"
    retrieved = [h["text"] for h in kb.vector.search(q, k=4, kind="style")]
    # Owner-provided examples lead the few-shot so drafts anchor on them first.
    few_shot = _dedup(load_overrides().get("examples") or [], retrieved)
    return profile, few_shot


def style_score(kb, draft_text: str) -> float:
    """0..1 — how well a draft matches the owner's voice (keyless)."""
    if not draft_text.strip():
        return 0.0
    v = kb.vector.embedder.embed(draft_text)
    sim = max(0.0, float(v @ style_centroid(kb)))          # embedding similarity
    rule = 1.0
    if "—" in draft_text:                                   # owner avoids em dashes
        rule -= 0.5
    if len(draft_text.split()) > 120:                       # owner is concise
        rule -= 0.2
    return round(0.6 * min(sim / 0.5, 1.0) + 0.4 * max(rule, 0.0), 3)

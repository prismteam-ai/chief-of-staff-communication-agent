"""Owner-authored style overrides.

The owner's writing style is learned automatically from their sent messages, but the
owner can also *explicitly* pin voice, sign-off, do/don't rules, and verbatim example
messages. Those overrides live in ``knowledge/style_overrides.json`` and are merged into
the learned ``StyleProfile`` (see ``cos.agents.style``), so drafts obey them directly.

File-backed to match the rest of the knowledge layer; a single JSON document, editable
from the Style page in the app (owner-only) via ``PUT /api/style``.
"""

from __future__ import annotations

import json

from cos.fixtures import DATA_DIR

_PATH = DATA_DIR.parent / "knowledge" / "style_overrides.json"
_PREFS = DATA_DIR.parent / "knowledge" / "preferences.json"

# Shape of the overrides document. Kept flat so the API and UI can round-trip it as-is.
_FIELDS = ("voice", "signoff", "rules", "examples")


def _prefs_defaults() -> dict:
    """Seed voice/sign-off from the legacy preferences.json so the editor is pre-filled
    the first time, before any override file exists."""
    out = {"voice": "", "signoff": ""}
    try:
        with open(_PREFS) as fh:
            for p in json.load(fh):
                if p.get("key") in out:
                    out[p["key"]] = p.get("value", "")
    except FileNotFoundError:
        pass
    return out


def load_overrides() -> dict:
    """Return ``{voice, signoff, rules, examples}``. Missing file -> prefs-seeded defaults."""
    base = _prefs_defaults()
    data = {"voice": base["voice"], "signoff": base["signoff"], "rules": [], "examples": []}
    try:
        with open(_PATH) as fh:
            saved = json.load(fh)
    except FileNotFoundError:
        return data
    if isinstance(saved, dict):
        for k in _FIELDS:
            if k in saved and saved[k] is not None:
                data[k] = saved[k]
    return data


def save_overrides(overrides: dict) -> dict:
    """Persist a cleaned copy and invalidate the style cache so the next draft picks it up."""
    clean = {
        "voice": str(overrides.get("voice", "") or "").strip(),
        "signoff": str(overrides.get("signoff", "") or "").strip(),
        "rules": [str(r).strip() for r in (overrides.get("rules") or []) if str(r).strip()],
        "examples": [str(e).strip() for e in (overrides.get("examples") or []) if str(e).strip()],
    }
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_PATH, "w") as fh:
        json.dump(clean, fh, indent=2)

    # Learned profiles are cached by content; drop the cache so edits take effect at once.
    from cos.agents import style
    style.invalidate_cache()
    return clean

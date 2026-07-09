"""LLM factory + key loading.

Keys are loaded from the external ArgminAI platform ``.env`` at runtime (never copied into
this repo, never printed). If ``OPENAI_API_KEY`` is already in the environment (e.g. a deploy),
that wins. The model defaults to ``OPENAI_MODEL`` (gpt-5.1). Provider-swappable: only this file
changes to move to Gemini/Claude.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

_DEFAULT_ENV = "/Users/dmitrijkonyrev/Documents/Work/ArgminAI/argminai_platform/.env"


def _load_keys() -> None:
    if os.environ.get("OPENAI_API_KEY"):
        return
    path = Path(os.environ.get("ARGMIN_ENV_PATH", _DEFAULT_ENV))
    if path.exists():
        load_dotenv(path, override=False)


_load_keys()


def has_key() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def model_name() -> str:
    return os.environ.get("OPENAI_MODEL", "gpt-5.1")


@lru_cache(maxsize=8)
def chat(temperature: float = 0.0, model: str | None = None):
    """A cached ChatOpenAI. gpt-5 family ignores temperature, so we omit it there."""
    from langchain_openai import ChatOpenAI

    m = model or model_name()
    kwargs = {"model": m, "timeout": 60, "max_retries": 2}
    if not m.startswith("gpt-5"):
        kwargs["temperature"] = temperature
    return ChatOpenAI(**kwargs)


def structured(schema, temperature: float = 0.0, model: str | None = None):
    """A runnable that returns a validated instance of the given Pydantic schema."""
    return chat(temperature, model).with_structured_output(schema)

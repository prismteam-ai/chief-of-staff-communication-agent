"""Environment-backed settings. All secrets live in .env (gitignored)."""
import logging
import os
import sys
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()

# errors are loud, silence is a bug: structured logs on every module, stderr
# (stdout is reserved — the MCP server speaks JSON-RPC over stdio)
logging.basicConfig(
    stream=sys.stderr,
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format='{"t":"%(asctime)s","lvl":"%(levelname)s","mod":"%(name)s","msg":"%(message)s"}',
)


class MissingConfig(RuntimeError):
    pass


def _req(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise MissingConfig(f"required env var {key} is not set (see .env.example)")
    return v


class Settings:
    def __init__(self) -> None:
        self.supabase_url = _req("SUPABASE_URL")
        self.supabase_service_key = _req("SUPABASE_SERVICE_ROLE_KEY")
        self.azure_chat_endpoint = _req("AZURE_OPENAI_ENDPOINT")
        self.azure_chat_key = _req("AZURE_OPENAI_API_KEY")
        # cost discipline: cheap fast model inside the per-message loop
        self.chat_deployment = os.environ.get("AZURE_CHAT_DEPLOYMENT", "gpt-5.4-mini")
        self.azure_embed_endpoint = _req("AZURE_OPENAI_EMBED_ENDPOINT")
        self.azure_embed_key = _req("AZURE_OPENAI_EMBED_API_KEY")
        self.embed_deployment = os.environ.get("AZURE_OPENAI_EMBED_DEPLOYMENT", "text-embedding-3-small")


@lru_cache
def settings() -> Settings:
    return Settings()

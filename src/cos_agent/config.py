"""Environment-backed settings. All secrets live in .env (gitignored)."""
import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


class Settings:
    def __init__(self) -> None:
        self.supabase_url = os.environ["SUPABASE_URL"]
        self.supabase_service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.azure_chat_endpoint = os.environ["AZURE_OPENAI_ENDPOINT"]
        self.azure_chat_key = os.environ["AZURE_OPENAI_API_KEY"]
        # cost discipline: cheap fast model inside the per-message loop
        self.chat_deployment = os.environ.get("AZURE_CHAT_DEPLOYMENT", "gpt-5.4-mini")
        self.azure_embed_endpoint = os.environ["AZURE_OPENAI_EMBED_ENDPOINT"]
        self.azure_embed_key = os.environ["AZURE_OPENAI_EMBED_API_KEY"]
        self.embed_deployment = os.environ.get("AZURE_OPENAI_EMBED_DEPLOYMENT", "text-embedding-3-small")
        self.fixture_dir = os.environ.get("FIXTURE_DIR", "data/fixtures")
        self.outbox_dir = os.environ.get("OUTBOX_DIR", "data/outbox")


@lru_cache
def settings() -> Settings:
    return Settings()

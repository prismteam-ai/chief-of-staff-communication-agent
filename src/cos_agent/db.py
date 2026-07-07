"""Supabase client singleton."""
from functools import lru_cache

from supabase import Client, create_client

from .config import settings


@lru_cache
def sb() -> Client:
    s = settings()
    return create_client(s.supabase_url, s.supabase_service_key)

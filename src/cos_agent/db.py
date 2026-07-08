"""Supabase client singleton + connection-failure resilience.

Supabase terminates idle HTTP/2 connections; with one shared client, every
in-flight builder on that connection dies with httpx.RemoteProtocolError
(observed as 500-bursts in the UI and failed brain runs under parallel load).
The builder chain is rebuilt per call and only execute() touches the network,
so a single retry — which draws a fresh pooled connection — is safe and
sufficient. PostgREST writes here are idempotent (upserts, keyed updates).
"""
import logging
import time
from functools import lru_cache

import httpx
from postgrest._sync import request_builder as _rb
from supabase import Client, create_client

from .config import settings

log = logging.getLogger(__name__)


def _with_retry(cls) -> None:
    orig = cls.execute

    def execute(self, *a, **kw):
        try:
            return orig(self, *a, **kw)
        except (httpx.RemoteProtocolError, httpx.ConnectError, httpx.ReadError) as e:
            log.warning("supabase connection dropped (%s) — retrying once", type(e).__name__)
            time.sleep(0.15)
            return orig(self, *a, **kw)

    cls.execute = execute


for _cls in (
    _rb.SyncQueryRequestBuilder,
    _rb.SyncSingleRequestBuilder,
    _rb.SyncMaybeSingleRequestBuilder,
):
    _with_retry(_cls)


@lru_cache
def sb() -> Client:
    s = settings()
    return create_client(s.supabase_url, s.supabase_service_key)

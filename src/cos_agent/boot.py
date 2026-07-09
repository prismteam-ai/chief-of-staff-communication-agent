"""Startup module (kept for import compatibility).

Connectors are no longer registered globally — they are resolved PER TENANT from
each owner's connector_tokens (see connectors/resolve.py). There is no fixture
fallback and no shared connector: real integrations only, owned by a user. This
module intentionally does nothing at import time now; `from . import boot` in
api.py / mcp_server.py is a harmless no-op retained to avoid churn.
"""
from __future__ import annotations

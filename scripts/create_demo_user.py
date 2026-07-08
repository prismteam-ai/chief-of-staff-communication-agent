"""Provision the demo login (idempotent). Usage:
  uv run python scripts/create_demo_user.py demo@meridianlabs.io <password>
"""
import sys

from cos_agent.db import sb

email, password = sys.argv[1], sys.argv[2]
existing = [u for u in sb().auth.admin.list_users() if u.email == email]
if existing:
    sb().auth.admin.update_user_by_id(existing[0].id, {"password": password})
    print(f"updated password for {email}")
else:
    sb().auth.admin.create_user({"email": email, "password": password, "email_confirm": True})
    print(f"created {email}")

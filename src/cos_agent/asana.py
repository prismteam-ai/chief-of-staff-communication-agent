"""Asana integration, PER TENANT.

Each user connects their OWN Asana — a PAT stored in connector_tokens (channel
'asana'), like any other connected service. Their tasks land in their own
workspace, isolated to their tenant. There is no shared/global workspace: a single
shared token would force every user to be an employee of one org (README:
"user-specific permission boundaries", "manage tokens for all connected services").
Workspace is auto-resolved from the token via /users/me — the user only pastes a PAT.
"""
from __future__ import annotations

import httpx

from .db import sb
from .rag import index_knowledge

ASANA_API = "https://app.asana.com/api/1.0"


class AsanaNotConnected(Exception):
    pass


COS_PROJECT_NAME = "Chief of Staff — Communications"


class RealAsana:
    def __init__(self, token: str) -> None:
        self._h = {"Authorization": f"Bearer {token}"}
        self._workspace: str | None = None
        self._project: str | None = None

    def _workspace_gid(self) -> str:
        if self._workspace:
            return self._workspace
        r = httpx.get(f"{ASANA_API}/users/me", headers=self._h, timeout=30)
        r.raise_for_status()
        workspaces = r.json()["data"].get("workspaces", [])
        if not workspaces:
            raise AsanaNotConnected("Asana token resolves to no workspace")
        self._workspace = workspaces[0]["gid"]
        return self._workspace

    def _project_gid(self) -> str:
        """Find-or-create a 'Chief of Staff' project so agent tasks land in a real
        project (visible in list/board views), not loose in the workspace."""
        if self._project:
            return self._project
        ws = self._workspace_gid()
        r = httpx.get(f"{ASANA_API}/projects", headers=self._h,
                      params={"workspace": ws, "opt_fields": "name", "limit": 100}, timeout=30)
        r.raise_for_status()
        for p in r.json().get("data", []):
            if "chief of staff" in (p.get("name") or "").lower():
                self._project = p["gid"]
                return self._project
        r = httpx.post(f"{ASANA_API}/projects", headers=self._h,
                       json={"data": {"name": COS_PROJECT_NAME, "workspace": ws}}, timeout=30)
        r.raise_for_status()
        self._project = r.json()["data"]["gid"]
        return self._project

    def create_task(self, name: str, notes: str) -> dict:
        data = {"name": name, "notes": notes, "workspace": self._workspace_gid(),
                "projects": [self._project_gid()]}
        r = httpx.post(f"{ASANA_API}/tasks", headers=self._h, json={"data": data}, timeout=30)
        r.raise_for_status()
        return r.json()["data"]

    def add_comment(self, task_gid: str, text: str) -> None:
        httpx.post(
            f"{ASANA_API}/tasks/{task_gid}/stories",
            headers=self._h, json={"data": {"text": text}}, timeout=30,
        ).raise_for_status()


def _asana_token(owner: str) -> dict | None:
    rows = (
        sb().table("connector_tokens").select("refresh_token, account_handle")
        .eq("owner_id", owner).eq("channel", "asana").execute().data
    )
    return rows[0] if rows else None


def is_connected(owner: str) -> bool:
    return _asana_token(owner) is not None


def client(owner: str) -> RealAsana | None:
    tok = _asana_token(owner)
    return RealAsana(tok["refresh_token"]) if tok else None


def task_from_message(message_id: str, owner: str, title: str, detail: str) -> dict:
    """Create an Asana task in the OWNER's workspace + record the link + index into RAG.
    Raises AsanaNotConnected if the tenant hasn't connected Asana (brain catches it, so a
    reply is never blocked by a missing Asana connection)."""
    c = client(owner)
    if c is None:
        raise AsanaNotConnected(f"tenant {owner} has not connected Asana")
    msg = (
        sb().table("messages").select("channel, sender, body_text, sent_at")
        .eq("id", message_id).eq("owner_id", owner).single().execute().data
    )
    sender = msg["sender"].get("display_name") or msg["sender"].get("handle")
    notes = (
        f"{detail}\n\n---\nSource communication ({msg['channel']}, {msg['sent_at']}) from {sender}:\n"
        f"{msg['body_text']}\n\nmessage_id: {message_id}"
    )
    task = c.create_task(name=title, notes=notes)
    sb().table("asana_links").insert(
        {
            "owner_id": owner,
            "message_id": message_id,
            "task_gid": task["gid"],
            "action": "created",
            "task_url": task.get("permalink_url", ""),
        }
    ).execute()
    index_knowledge(
        owner,
        "asana",
        task["gid"],
        f"Asana task: {title}. {detail} (from {msg['channel']} message by {sender})",
        {"task_url": task.get("permalink_url", ""), "message_id": message_id},
    )
    return task

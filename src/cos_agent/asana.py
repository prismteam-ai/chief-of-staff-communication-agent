"""Asana integration behind one interface.

Real client activates when ASANA_ACCESS_TOKEN is set (workspace pending from
Arthur); until then FixtureAsana writes auditable task JSON to data/asana_outbox/
with the same contract, so the create/link flow is real end-to-end today and the
provider swaps in without touching callers.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .db import sb
from .rag import index_knowledge

ASANA_API = "https://app.asana.com/api/1.0"


class FixtureAsana:
    mode = "fixture"

    def __init__(self) -> None:
        self.out = Path(os.environ.get("ASANA_OUTBOX_DIR", "data/asana_outbox"))

    def create_task(self, name: str, notes: str) -> dict:
        self.out.mkdir(parents=True, exist_ok=True)
        gid = f"fx-{uuid.uuid4().hex[:12]}"
        task = {
            "gid": gid,
            "name": name,
            "notes": notes,
            "permalink_url": f"https://app.asana.com/0/demo/{gid}",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        (self.out / f"{gid}.json").write_text(json.dumps(task, indent=2))
        return task

    def add_comment(self, task_gid: str, text: str) -> None:
        p = self.out / f"{task_gid}.json"
        if p.exists():
            task = json.loads(p.read_text())
            task.setdefault("comments", []).append(
                {"text": text, "at": datetime.now(timezone.utc).isoformat()}
            )
            p.write_text(json.dumps(task, indent=2))


class RealAsana:
    mode = "real"

    def __init__(self, token: str, workspace_gid: str, project_gid: str | None) -> None:
        self._h = {"Authorization": f"Bearer {token}"}
        self.workspace_gid = workspace_gid
        self.project_gid = project_gid

    def create_task(self, name: str, notes: str) -> dict:
        data: dict = {"name": name, "notes": notes, "workspace": self.workspace_gid}
        if self.project_gid:
            data["projects"] = [self.project_gid]
        r = httpx.post(f"{ASANA_API}/tasks", headers=self._h, json={"data": data}, timeout=30)
        r.raise_for_status()
        return r.json()["data"]

    def add_comment(self, task_gid: str, text: str) -> None:
        httpx.post(
            f"{ASANA_API}/tasks/{task_gid}/stories",
            headers=self._h, json={"data": {"text": text}}, timeout=30,
        ).raise_for_status()


def client():
    token = os.environ.get("ASANA_ACCESS_TOKEN")
    if token:
        return RealAsana(
            token,
            os.environ["ASANA_WORKSPACE_GID"],
            os.environ.get("ASANA_PROJECT_GID"),
        )
    return FixtureAsana()


def task_from_message(message_id: str, owner: str, title: str, detail: str) -> dict:
    """Create an Asana task from a communication + record the link + index into RAG,
    all owned by `owner` (the message must belong to them)."""
    msg = (
        sb().table("messages").select("channel, sender, body_text, sent_at")
        .eq("id", message_id).eq("owner_id", owner).single().execute().data
    )
    sender = msg["sender"].get("display_name") or msg["sender"].get("handle")
    notes = (
        f"{detail}\n\n---\nSource communication ({msg['channel']}, {msg['sent_at']}) from {sender}:\n"
        f"{msg['body_text']}\n\nmessage_id: {message_id}"
    )
    task = client().create_task(name=title, notes=notes)
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

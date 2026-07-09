"""Mock of the Asana REST API endpoints python-asana calls (base path /api/1.0).

Covers tasks, milestones (tasks with resource_subtype=milestone), projects, comments
(stories), assignment, and deletion — the object types the assignment names.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from cos.mocks.store import store

router = APIRouter(prefix="/api/1.0")


def _find(gid: str) -> dict | None:
    return next((t for t in store.asana["tasks"] if t["gid"] == gid), None)


@router.get("/projects")
def list_projects():
    return {"data": store.asana["projects"]}


@router.get("/tasks")
def list_tasks(project: str | None = None, is_milestone: bool | None = None):
    tasks = store.asana["tasks"]
    if project:
        tasks = [t for t in tasks if any(p["gid"] == project for p in t.get("projects", []))]
    if is_milestone is not None:
        tasks = [t for t in tasks if t.get("is_milestone", False) == is_milestone]
    return {"data": tasks}


@router.get("/tasks/{gid}")
def get_task(gid: str):
    t = _find(gid)
    return {"data": t} if t else {"errors": [{"message": "task: Not a recognized ID"}]}


@router.post("/tasks")
async def create_task(request: Request):
    body = (await request.json()).get("data", {})
    gid = store.next_id("1209900000")  # distinct prefix so created ids never collide
    is_ms = body.get("resource_subtype") == "milestone"
    projects = [{"gid": p, "name": next((x["name"] for x in store.asana["projects"]
                                         if x["gid"] == p), "")}
                for p in body.get("projects", [])]
    task = {
        "gid": gid, "name": body.get("name", ""), "notes": body.get("notes", ""),
        "completed": bool(body.get("completed", False)), "due_on": body.get("due_on"),
        "resource_subtype": "milestone" if is_ms else "default_task", "is_milestone": is_ms,
        "assignee": {"gid": "1203000000000001", "name": "Dmitrii Konyrev"},
        "projects": projects, "permalink_url": f"https://app.asana.com/0/0/{gid}"}
    store.asana["tasks"].append(task)
    return {"data": task}


@router.put("/tasks/{gid}")
async def update_task(gid: str, request: Request):
    body = (await request.json()).get("data", {})
    t = _find(gid)
    if not t:
        return {"errors": [{"message": "task: Not a recognized ID"}]}
    for k in ("name", "notes", "completed", "due_on"):
        if k in body:
            t[k] = body[k]
    if "assignee" in body:
        t["assignee"] = {"gid": "1203000000000009", "name": str(body["assignee"])}
    return {"data": t}


@router.delete("/tasks/{gid}")
def delete_task(gid: str):
    t = _find(gid)
    if not t:
        return {"errors": [{"message": "task: Not a recognized ID"}]}
    store.asana["tasks"].remove(t)
    return {"data": {}}


@router.get("/tasks/{gid}/stories")
def list_stories(gid: str):
    return {"data": store.asana.setdefault("stories", {}).get(gid, [])}


@router.post("/tasks/{gid}/stories")
async def create_story(gid: str, request: Request):
    body = (await request.json()).get("data", {})
    story = {"gid": store.next_id("13000000"), "text": body.get("text", ""),
             "resource_subtype": "comment_added", "type": "comment",
             "created_by": {"name": "Dmitrii Konyrev"}}
    store.asana.setdefault("stories", {}).setdefault(gid, []).append(story)
    return {"data": story}

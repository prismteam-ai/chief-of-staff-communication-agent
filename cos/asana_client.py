"""Asana client — real python-asana SDK, host pointed at the mock.

Covers the Asana surface the assignment names: tasks, milestones, projects, comments,
assignment, completion, and deletion. Only ``configuration.host`` and the access token
change between mock and real; the calls are production code.
"""

from __future__ import annotations

import asana

from cos.config import get_settings
from cos.models import Comment, Project, Task


def _to_task(d: dict) -> Task:
    return Task(
        gid=d["gid"], name=d.get("name", ""), notes=d.get("notes", "") or "",
        completed=bool(d.get("completed", False)), due_on=d.get("due_on"),
        # Real Asana marks milestones via resource_subtype; the mock also sends is_milestone.
        is_milestone=bool(d.get("is_milestone", False))
        or d.get("resource_subtype") == "milestone",
        assignee=(d.get("assignee") or {}).get("name"),
        project_gids=[p["gid"] for p in d.get("projects", [])],
        permalink_url=d.get("permalink_url"))


_FIELDS = ("name,notes,completed,due_on,is_milestone,resource_subtype,"
           "assignee.name,projects.name,permalink_url")


class AsanaClient:
    def __init__(self) -> None:
        s = get_settings()
        cfg = asana.Configuration()
        cfg.host = s.asana_base_url
        cfg.access_token = s.asana_token
        api = asana.ApiClient(cfg)
        self.tasks = asana.TasksApi(api)
        self.projects = asana.ProjectsApi(api)
        self.stories = asana.StoriesApi(api)

    @staticmethod
    def _data(resp) -> dict:
        if isinstance(resp, dict):
            if "errors" in resp and "data" not in resp:
                raise LookupError(resp["errors"][0].get("message", "asana error"))
            return resp.get("data", resp)
        return resp

    # ---- reads --------------------------------------------------------------
    def list_projects(self) -> list[Project]:
        # Real Asana requires a workspace to list projects; the mock ignores it.
        opts = {"opt_fields": "name", "workspace": get_settings().asana_workspace_gid}
        return [Project(gid=self._data(p)["gid"], name=self._data(p)["name"])
                for p in self.projects.get_projects(opts)]

    def list_tasks(self, project: str | None = None, milestones_only: bool = False
                   ) -> list[Task]:
        opts = {"opt_fields": _FIELDS}
        if project:
            opts["project"] = project
            results = [_to_task(self._data(t)) for t in self.tasks.get_tasks(opts)]
        else:
            # No project given: real Asana rejects a container-less task list, so aggregate
            # every project in the workspace (deduped by gid). The mock returns all tasks
            # per project too, so this path is identical there.
            out: dict[str, Task] = {}
            for p in self.list_projects():
                for t in self.tasks.get_tasks(dict(opts, project=p.gid)):
                    d = self._data(t)
                    out[d["gid"]] = _to_task(d)
            results = list(out.values())
        # Real Asana has no is_milestone query filter, so select milestones client-side.
        if milestones_only:
            results = [t for t in results if t.is_milestone]
        return results

    def list_milestones(self) -> list[Task]:
        return self.list_tasks(milestones_only=True)

    def get_task(self, gid: str) -> Task:
        return _to_task(self._data(self.tasks.get_task(gid, {"opt_fields": _FIELDS})))

    # ---- task ops -----------------------------------------------------------
    def create_task(self, name: str, notes: str = "", project: str | None = None,
                    linked_message_id: str | None = None) -> Task:
        data = {"name": name, "notes": notes}
        if project:
            data["projects"] = [project]
        else:
            # Real Asana rejects a task with no container: it needs one of
            # workspace / parent / projects. Fall back to the configured workspace.
            data["workspace"] = get_settings().asana_workspace_gid
        task = _to_task(self._data(self.tasks.create_task({"data": data}, {})))
        task.linked_message_id = linked_message_id
        return task

    def create_milestone(self, name: str, project: str, due_on: str | None = None,
                         linked_message_id: str | None = None) -> Task:
        data = {"name": name, "resource_subtype": "milestone", "projects": [project]}
        if due_on:
            data["due_on"] = due_on
        task = _to_task(self._data(self.tasks.create_task({"data": data}, {})))
        task.linked_message_id = linked_message_id
        return task

    def update_task(self, gid: str, **fields) -> Task:
        return _to_task(self._data(self.tasks.update_task({"data": fields}, gid, {})))

    def complete_task(self, gid: str) -> Task:
        return self.update_task(gid, completed=True)

    def assign_task(self, gid: str, assignee: str) -> Task:
        return self.update_task(gid, assignee=assignee)

    def delete_task(self, gid: str) -> None:
        self.tasks.delete_task(gid)

    def add_comment(self, task_gid: str, text: str) -> Comment:
        d = self._data(self.stories.create_story_for_task({"data": {"text": text}},
                                                          task_gid, {}))
        return Comment(gid=d["gid"], task_gid=task_gid, text=d.get("text", text),
                       created_by=(d.get("created_by") or {}).get("name"))

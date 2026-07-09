"""Seed the real Asana workspace with the demo scenario's projects, tasks, and milestones.

Reads the fixture (``cos/fixtures/data/asana.json``) and recreates it in the live workspace
named by ``ASANA_WORKSPACE_GID``, using the real token in ``ASANA_TOKEN``. Idempotent:
projects and tasks are matched by name, so re-running does not duplicate.

Run once, then point ``ASANA_BASE_URL`` at ``https://app.asana.com/api/1.0`` so the app
reads these real tasks.

    python -m cos.scripts.seed_asana            # seed
    python -m cos.scripts.seed_asana --dry-run  # show what it would do
"""

from __future__ import annotations

import sys

import asana

from cos.config import get_settings
from cos.fixtures import load

REAL_HOST = "https://app.asana.com/api/1.0"


def _client() -> asana.ApiClient:
    s = get_settings()
    if not s.asana_token or s.asana_token.startswith("mock"):
        sys.exit("ASANA_TOKEN is not a real token — set it in .env before seeding.")
    cfg = asana.Configuration()
    cfg.host = REAL_HOST                 # always the real API, regardless of MODE/base URL
    cfg.access_token = s.asana_token
    return asana.ApiClient(cfg)


def main(dry_run: bool = False) -> None:
    s = get_settings()
    ws = s.asana_workspace_gid
    api = _client()
    projects_api = asana.ProjectsApi(api)
    tasks_api = asana.TasksApi(api)
    users_api = asana.UsersApi(api)

    me = users_api.get_user("me", {"opt_fields": "gid,name"})
    me_gid = me["gid"] if isinstance(me, dict) else me.gid
    fixture = load("asana.json")

    # ---- projects (get-or-create by name) -----------------------------------
    existing = {p["name"]: p["gid"]
                for p in projects_api.get_projects({"workspace": ws, "opt_fields": "name"})}
    name_to_gid: dict[str, str] = {}
    for p in fixture["projects"]:
        name = p["name"]
        if name in existing:
            name_to_gid[name] = existing[name]
            print(f"project exists: {name}")
            continue
        if dry_run:
            print(f"[dry-run] would create project: {name}")
            name_to_gid[name] = f"dry:{name}"
            continue
        res = projects_api.create_project({"data": {"name": name, "workspace": ws}},
                                          {"opt_fields": "name"})
        gid = res["gid"] if isinstance(res, dict) else res.gid
        name_to_gid[name] = gid
        print(f"created project: {name} -> {gid}")

    # ---- tasks (get-or-create by name within its project) -------------------
    created_ct = skipped_ct = 0
    for t in fixture["tasks"]:
        proj_names = [p["name"] for p in t.get("projects", [])]
        proj_gid = name_to_gid.get(proj_names[0]) if proj_names else None
        if not proj_gid:
            print(f"  ! no project for task {t['name']!r}, skipping")
            continue

        # skip if a task with this name already exists in the project
        if not dry_run and not str(proj_gid).startswith("dry:"):
            here = {x["name"] for x in tasks_api.get_tasks(
                {"project": proj_gid, "opt_fields": "name"})}
            if t["name"] in here:
                skipped_ct += 1
                continue

        data = {
            "name": t["name"],
            "notes": t.get("notes", "") or "",
            "projects": [proj_gid],
            "assignee": me_gid,
        }
        if t.get("due_on"):
            data["due_on"] = t["due_on"]
        if t.get("is_milestone"):
            data["resource_subtype"] = "milestone"
        if t.get("completed"):
            data["completed"] = True

        if dry_run or str(proj_gid).startswith("dry:"):
            kind = "milestone" if t.get("is_milestone") else "task"
            print(f"[dry-run] would create {kind}: {t['name']} (proj={proj_names[0]})")
            created_ct += 1
            continue

        res = tasks_api.create_task({"data": data}, {"opt_fields": "name,permalink_url"})
        gid = res["gid"] if isinstance(res, dict) else res.gid
        created_ct += 1
        print(f"created {'milestone' if t.get('is_milestone') else 'task'}: "
              f"{t['name']} -> {gid}")

    print(f"\nDone. projects={len(name_to_gid)} tasks_created={created_ct} "
          f"tasks_skipped={skipped_ct} workspace={ws}")


if __name__ == "__main__":
    main(dry_run="--dry-run" in sys.argv)

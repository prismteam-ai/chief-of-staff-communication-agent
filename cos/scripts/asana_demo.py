"""Asana demo: exercise the full op set the agent uses — tasks, milestones, comments,
assignment, completion, deletion — via python-asana against the mock.

Run (mock server must be up): ``python -m cos.scripts.asana_demo``
"""

from __future__ import annotations

from cos.asana_client import AsanaClient


def main() -> None:
    c = AsanaClient()

    projects = c.list_projects()
    tasks = c.list_tasks()
    milestones = c.list_milestones()
    print(f"Projects: {len(projects)}  Tasks: {len(tasks)}  Milestones: {len(milestones)}")
    for m in milestones[:4]:
        print(f"  ⭑ {m.name}  (due {m.due_on})")

    # CREATE_TASK from a communication
    t = c.create_task(name="Reply to Sarah re: Series A term sheet",
                      notes="Auto-created from Gmail thread. Redline due Friday.",
                      project="1201000000000001",
                      linked_message_id="gmail:gmailmsg-001-0")
    print(f"\nCREATE_TASK  {t.gid}: {t.name}  (linked {t.linked_message_id})")

    # COMMENT_ON_TASK — log the decision back onto the task
    cm = c.add_comment(t.gid, "Sent redline to Sarah; pushing back on the observer seat.")
    print(f"COMMENT      {cm.gid}: \"{cm.text[:48]}...\"")

    # ASSIGN_TASK
    a = c.assign_task(t.gid, "Mia Anders")
    print(f"ASSIGN       -> {a.assignee}")

    # CREATE_MILESTONE
    ms = c.create_milestone(name="Series A wire received", project="1201000000000001",
                            due_on="2026-07-18")
    print(f"CREATE_MILESTONE {ms.gid}: {ms.name}  is_milestone={ms.is_milestone}")

    # COMPLETE_TASK
    done = c.complete_task(t.gid)
    print(f"COMPLETE     completed={done.completed}")

    # DELETE_TASK (cancelled work)
    c.delete_task(ms.gid)
    print(f"DELETE       removed {ms.gid}")


if __name__ == "__main__":
    main()

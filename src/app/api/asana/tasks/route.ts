import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { asanaGet, AsanaError } from "@/lib/asana";

const TASK_FIELDS =
  "name,completed,due_on,due_at,assignee.name,projects.name,modified_at,num_subtasks";

interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  due_on?: string | null;
  due_at?: string | null;
  assignee?: { name: string } | null;
  projects?: { gid: string; name: string }[];
  modified_at?: string;
  num_subtasks?: number;
}

/**
 * GET /api/asana/tasks?workspace=&project=&view=
 *  - view=mine (default): tasks assigned to me in the workspace
 *  - project=<gid>: tasks in that project
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = req.nextUrl.searchParams.get("project");
  const workspace = req.nextUrl.searchParams.get("workspace");
  const includeCompleted = req.nextUrl.searchParams.get("completed") === "1";

  try {
    let tasks: AsanaTask[];
    if (project) {
      tasks = await asanaGet<AsanaTask[]>(session.user.id, "/tasks", {
        project,
        opt_fields: TASK_FIELDS,
        limit: "100",
      });
    } else {
      if (!workspace) {
        return NextResponse.json({ error: "workspace is required" }, { status: 400 });
      }
      const params: Record<string, string> = {
        assignee: "me",
        workspace,
        opt_fields: TASK_FIELDS,
        limit: "100",
      };
      if (!includeCompleted) params.completed_since = "now";
      tasks = await asanaGet<AsanaTask[]>(session.user.id, "/tasks", params);
    }

    if (!includeCompleted) tasks = tasks.filter((t) => !t.completed);

    return NextResponse.json({ tasks });
  } catch (err) {
    const status = err instanceof AsanaError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Asana request failed" },
      { status }
    );
  }
}

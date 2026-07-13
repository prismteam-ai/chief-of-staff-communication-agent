import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { asanaGet, AsanaError } from "@/lib/asana";

/** GET /api/asana/tasks/[id] — full task with subtasks and comments. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const [task, subtasks, stories] = await Promise.all([
      asanaGet<unknown>(session.user.id, `/tasks/${id}`, {
        opt_fields:
          "name,notes,completed,due_on,due_at,created_at,modified_at," +
          "assignee.name,followers.name,projects.name,memberships.section.name,permalink_url,tags.name",
      }),
      asanaGet<unknown[]>(session.user.id, `/tasks/${id}/subtasks`, {
        opt_fields: "name,completed,assignee.name,due_on",
        limit: "50",
      }),
      asanaGet<unknown[]>(session.user.id, `/tasks/${id}/stories`, {
        opt_fields: "type,text,created_at,created_by.name",
        limit: "100",
      }),
    ]);

    interface Story { type?: string }
    return NextResponse.json({
      task,
      subtasks,
      comments: (stories as Story[]).filter((s) => s.type === "comment"),
    });
  } catch (err) {
    const status = err instanceof AsanaError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Asana request failed" },
      { status }
    );
  }
}

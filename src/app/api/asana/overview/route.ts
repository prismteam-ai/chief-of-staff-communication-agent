import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { asanaGet, AsanaError } from "@/lib/asana";

interface AsanaUser {
  gid: string;
  name: string;
  email?: string;
  workspaces: { gid: string; name: string }[];
}
interface AsanaProject {
  gid: string;
  name: string;
  color?: string | null;
  archived?: boolean;
}

/** GET /api/asana/overview?workspace= — me, workspaces, and projects. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const me = await asanaGet<AsanaUser>(session.user.id, "/users/me", {
      opt_fields: "name,email,workspaces.name",
    });
    const workspaceGid =
      req.nextUrl.searchParams.get("workspace") ?? me.workspaces[0]?.gid;
    if (!workspaceGid) {
      return NextResponse.json({ me, workspaces: me.workspaces, projects: [] });
    }

    const projects = await asanaGet<AsanaProject[]>(session.user.id, "/projects", {
      workspace: workspaceGid,
      opt_fields: "name,color,archived",
      limit: "100",
    });

    return NextResponse.json({
      me: { gid: me.gid, name: me.name, email: me.email },
      workspaces: me.workspaces,
      workspace: workspaceGid,
      projects: projects.filter((p) => !p.archived),
    });
  } catch (err) {
    const status = err instanceof AsanaError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Asana request failed" },
      { status }
    );
  }
}

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runAgents } from "@/lib/agent-runtime";

/** POST /api/agents/run — run all active auto-reply agents over recent inbound messages. */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runAgents(session.user.id);
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Agent run failed" },
      { status: 500 }
    );
  }
}

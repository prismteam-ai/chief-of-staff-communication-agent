import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { dispatchAction } from "@/lib/agent-runtime";

/**
 * POST /api/actions/[id] — resolve a pending action.
 * Body: { decision: "approve" | "reject", body?: string (edited draft) }
 * Approving sends the message through the real channel.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const action = await prisma.agentAction.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!action) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (action.status !== "pending_approval") {
    return NextResponse.json(
      { error: `Action is ${action.status}, not pending approval` },
      { status: 400 }
    );
  }

  const payload = await req.json().catch(() => ({}));
  const decision = payload.decision;

  if (decision === "reject") {
    const updated = await prisma.agentAction.update({
      where: { id },
      data: { status: "rejected", resolvedAt: new Date() },
    });
    return NextResponse.json({ action: updated });
  }

  if (decision === "approve") {
    if (typeof payload.body === "string" && payload.body.trim()) {
      await prisma.agentAction.update({
        where: { id },
        data: { body: payload.body.trim() },
      });
    }
    const ok = await dispatchAction(id);
    const updated = await prisma.agentAction.findUnique({ where: { id } });
    return NextResponse.json({ action: updated }, { status: ok ? 200 : 502 });
  }

  return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 });
}

/** DELETE /api/actions/[id] — remove an action from history. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const action = await prisma.agentAction.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!action) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.agentAction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { dispatchAction } from "@/lib/agent-runtime";
import { generateDraft } from "@/lib/agent-runtime/draft";

/**
 * POST /api/actions/[id] — resolve a pending action.
 * Body: { decision: "approve" | "reject" | "context",
 *         body?: string (edited draft), context?: string (extra info) }
 * - approve: sends the message through the real channel
 * - context: regenerates the draft using the extra context you provide
 *   (turns a needs_context action into a normal reply awaiting approval)
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

  if (decision === "context") {
    const context = typeof payload.context === "string" ? payload.context.trim() : "";
    if (!context) {
      return NextResponse.json({ error: "context is required" }, { status: 400 });
    }
    const [agent, message] = await Promise.all([
      prisma.agent.findUnique({ where: { id: action.agentId } }),
      action.messageId
        ? prisma.message.findUnique({
            where: { id: action.messageId },
            include: { participants: { where: { role: "from" } } },
          })
        : null,
    ]);
    if (!agent || !message) {
      return NextResponse.json({ error: "Agent or message no longer exists" }, { status: 400 });
    }
    const from = message.participants[0];
    const body = await generateDraft(agent, {
      channel: message.provider,
      senderName: from?.name,
      senderAddress: from?.address ?? action.recipient,
      subject: message.subject,
      body: message.body ?? message.snippet ?? "",
      skillContext: `Information provided by your principal to answer with:\n${context}`,
    });
    const updated = await prisma.agentAction.update({
      where: { id },
      data: {
        body,
        type: "reply",
        statusNote: null,
        recommendation: "Reply with the draft written from your provided context.",
      },
    });
    return NextResponse.json({ action: updated });
  }

  if (decision === "approve") {
    if (action.type === "needs_context" && !(typeof payload.body === "string" && payload.body.trim())) {
      return NextResponse.json(
        { error: "This action needs a reply body — provide context or write the reply first" },
        { status: 400 }
      );
    }
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

  return NextResponse.json(
    { error: "decision must be approve, reject or context" },
    { status: 400 }
  );
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

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/** GET /api/actions?status= — the user's agent actions (approvals queue & history). */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const actions = await prisma.agentAction.findMany({
    where: { userId: session.user.id, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      agent: { select: { name: true, mode: true } },
      message: {
        select: {
          subject: true,
          snippet: true,
          sentAt: true,
          provider: true,
          participants: { where: { role: "from" }, select: { name: true, address: true } },
        },
      },
    },
  });

  return NextResponse.json({ actions });
}

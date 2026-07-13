import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/** GET /api/inbox/threads/[id] — full thread with messages, participants, attachments. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const thread = await prisma.thread.findFirst({
    where: { id, userId: session.user.id },
    include: {
      messages: {
        orderBy: { sentAt: "asc" },
        include: {
          participants: true,
          attachments: true,
        },
      },
    },
  });
  if (!thread) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ thread });
}

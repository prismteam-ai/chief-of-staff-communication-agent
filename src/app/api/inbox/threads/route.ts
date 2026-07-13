import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/** GET /api/inbox/threads?provider=&q= — the user's threads, newest first. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provider = req.nextUrl.searchParams.get("provider") ?? undefined;
  const q = req.nextUrl.searchParams.get("q") ?? undefined;

  const threads = await prisma.thread.findMany({
    where: {
      userId: session.user.id,
      ...(provider ? { provider } : {}),
      ...(q ? { subject: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    include: {
      messages: {
        orderBy: { sentAt: "desc" },
        take: 1,
        select: {
          snippet: true,
          sentAt: true,
          isOutbound: true,
          participants: { where: { role: "from" }, select: { name: true, address: true } },
          _count: { select: { attachments: true } },
        },
      },
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    threads: threads.map((t) => ({
      id: t.id,
      provider: t.provider,
      subject: t.subject,
      lastMessageAt: t.lastMessageAt,
      messageCount: t._count.messages,
      latest: t.messages[0]
        ? {
            snippet: t.messages[0].snippet,
            sentAt: t.messages[0].sentAt,
            isOutbound: t.messages[0].isOutbound,
            from: t.messages[0].participants[0] ?? null,
            attachmentCount: t.messages[0]._count.attachments,
          }
        : null,
    })),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { indexUserKnowledge } from "@/lib/rag/indexer";

/** GET /api/knowledge?kind=org|preference — list knowledge items. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const kind = req.nextUrl.searchParams.get("kind") ?? undefined;
  const items = await prisma.knowledgeItem.findMany({
    where: { userId: session.user.id, ...(kind ? { kind } : {}) },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ items });
}

/** POST /api/knowledge — create a knowledge item { kind, title, content }. */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const kind = body.kind === "preference" ? "preference" : "org";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!title || !content) {
    return NextResponse.json({ error: "title and content are required" }, { status: 400 });
  }
  const item = await prisma.knowledgeItem.create({
    data: { userId: session.user.id, kind, title, content },
  });
  // index immediately so it's retrievable right away
  indexUserKnowledge(session.user.id).catch(() => {});
  return NextResponse.json({ item }, { status: 201 });
}

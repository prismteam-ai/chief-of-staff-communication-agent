import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/** DELETE /api/knowledge/[id] — remove a knowledge item (chunk pruned on next index). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const item = await prisma.knowledgeItem.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.knowledgeItem.delete({ where: { id } });
  await prisma.knowledgeChunk.deleteMany({
    where: { userId: session.user.id, source: item.kind, sourceId: id },
  });
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { retrieve } from "@/lib/rag/retrieve";
import { indexUserKnowledge } from "@/lib/rag/indexer";

/** GET /api/rag/search?q=...&k=6 — search the knowledge index. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  const k = Math.min(Number(req.nextUrl.searchParams.get("k")) || 8, 25);
  const results = await retrieve(session.user.id, q, { k });
  return NextResponse.json({ results });
}

/** POST /api/rag/search — rebuild the knowledge index now. */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await indexUserKnowledge(session.user.id);
  return NextResponse.json(summary);
}

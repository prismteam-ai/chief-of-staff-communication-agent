import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { findRelatedMessages } from "@/lib/related";

/**
 * GET /api/inbox/messages/[id]/related — messages across all channels linked
 * to this one by person, topic, or Asana project mention.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const related = await findRelatedMessages(session.user.id, id);
    return NextResponse.json({ related });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed" },
      { status: 404 }
    );
  }
}

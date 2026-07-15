import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getProvider } from "@/lib/providers";
import { ingestors, INGEST_UNSUPPORTED } from "@/lib/ingest";
import { syncConnection } from "@/lib/sync";

/** POST /api/connections/[provider]/sync — ingest new messages for a channel. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  if (!ingestors[provider.id]) {
    return NextResponse.json(
      { error: INGEST_UNSUPPORTED[provider.id] ?? "Ingestion not supported for this channel" },
      { status: 400 }
    );
  }

  try {
    const result = await syncConnection(userId, provider.id);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    const status = message === "Channel not connected" ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

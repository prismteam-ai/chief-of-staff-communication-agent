import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers";
import { getCredentials, getFreshAccessToken } from "@/lib/connections";
import { ingestors, INGEST_UNSUPPORTED, persistMessages } from "@/lib/ingest";

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

  const ingestor = ingestors[provider.id];
  if (!ingestor) {
    return NextResponse.json(
      { error: INGEST_UNSUPPORTED[provider.id] ?? "Ingestion not supported for this channel" },
      { status: 400 }
    );
  }

  const conn = await prisma.channelConnection.findUnique({
    where: { userId_provider: { userId, provider: provider.id } },
  });
  if (!conn) {
    return NextResponse.json({ error: "Channel not connected" }, { status: 400 });
  }

  try {
    const ctx = {
      userId,
      cursor: conn.syncCursor,
      accountLabel: conn.accountLabel,
      accessToken:
        provider.kind === "oauth"
          ? (await getFreshAccessToken(userId, provider.id)) ?? undefined
          : undefined,
      credentials:
        provider.kind === "credentials"
          ? (await getCredentials(userId, provider.id)) ?? undefined
          : undefined,
    };
    if (provider.kind === "oauth" && !ctx.accessToken) {
      return NextResponse.json(
        { error: "No valid access token — reconnect this channel" },
        { status: 400 }
      );
    }

    const result = await ingestor(ctx);
    const { inserted, skipped } = await persistMessages(userId, provider.id, result.messages);

    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: {
        syncCursor: result.nextCursor ?? conn.syncCursor,
        lastSyncAt: new Date(),
        status: "connected",
        lastError: null,
      },
    });

    return NextResponse.json({ inserted, skipped, fetched: result.messages.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { status: "error", lastError: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

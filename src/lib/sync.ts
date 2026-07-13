import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers";
import { getCredentials, getFreshAccessToken } from "@/lib/connections";
import { ingestors, persistMessages } from "@/lib/ingest";

export interface SyncResult {
  inserted: number;
  skipped: number;
  fetched: number;
}

/**
 * Ingest new messages for one connected channel. Shared by the manual sync
 * API route and the background scheduler.
 */
export async function syncConnection(userId: string, providerId: string): Promise<SyncResult> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error("Unknown provider");

  const ingestor = ingestors[provider.id];
  if (!ingestor) throw new Error("Ingestion not supported for this channel");

  const conn = await prisma.channelConnection.findUnique({
    where: { userId_provider: { userId, provider: provider.id } },
  });
  if (!conn) throw new Error("Channel not connected");

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
      throw new Error("No valid access token — reconnect this channel");
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

    return { inserted, skipped, fetched: result.messages.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { status: "error", lastError: message },
    });
    throw err instanceof Error ? err : new Error(message);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers";
import { getCredentials, getFreshAccessToken } from "@/lib/connections";

/** POST /api/connections/[provider]/test — verify a connection is healthy. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  const userId = session.user.id;
  let result: { ok: boolean; label?: string; error?: string };

  if (provider.kind === "oauth") {
    const token = await getFreshAccessToken(userId, provider.id);
    result = token
      ? await provider.testConnection(token)
      : { ok: false, error: "No valid access token — reconnect this channel" };
  } else {
    const credentials = await getCredentials(userId, provider.id);
    result = credentials
      ? await provider.testConnection(credentials)
      : { ok: false, error: "Not connected" };
  }

  await prisma.channelConnection
    .update({
      where: { userId_provider: { userId, provider: provider.id } },
      data: {
        status: result.ok ? "connected" : "error",
        lastCheckAt: new Date(),
        lastError: result.ok ? null : result.error ?? "Unknown error",
        ...(result.label ? { accountLabel: result.label } : {}),
      },
    })
    .catch(() => {});

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

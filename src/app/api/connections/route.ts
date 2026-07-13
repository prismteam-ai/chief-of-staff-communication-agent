import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { providers } from "@/lib/providers";
import { isConfigured } from "@/lib/providers/oauth";

/** GET /api/connections — the signed-in user's channel connection statuses. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connections = await prisma.channelConnection.findMany({
    where: { userId: session.user.id },
    select: {
      provider: true,
      status: true,
      accountLabel: true,
      scopes: true,
      expiresAt: true,
      lastCheckAt: true,
      lastError: true,
      createdAt: true,
    },
  });
  const byProvider = new Map(connections.map((c) => [c.provider, c]));

  const channels = Object.values(providers).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    kind: p.kind,
    fields: p.kind === "credentials" ? p.fields : undefined,
    helpUrl: p.kind === "credentials" ? p.helpUrl : undefined,
    configured: p.kind === "oauth" ? isConfigured(p) : true,
    connection: byProvider.get(p.id) ?? null,
  }));

  return NextResponse.json({ channels });
}

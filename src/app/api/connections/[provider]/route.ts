import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { getProvider } from "@/lib/providers";
import { saveCredentialConnection } from "@/lib/connections";

/** POST /api/connections/[provider] — connect a credential-based channel (WhatsApp, SMS). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider || provider.kind !== "credentials") {
    return NextResponse.json({ error: "Unknown credential provider" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const credentials: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = typeof body[field.name] === "string" ? body[field.name].trim() : "";
    if (!value) {
      return NextResponse.json({ error: `${field.label} is required` }, { status: 400 });
    }
    credentials[field.name] = value;
  }

  const test = await provider.testConnection(credentials);
  if (!test.ok) {
    return NextResponse.json(
      { error: test.error ?? "Credential validation failed" },
      { status: 400 }
    );
  }

  const conn = await saveCredentialConnection(
    session.user.id,
    provider.id,
    credentials,
    test.label
  );
  return NextResponse.json({
    connection: { provider: conn.provider, status: conn.status, accountLabel: conn.accountLabel },
  });
}

/** DELETE /api/connections/[provider] — disconnect a channel and revoke tokens. */
export async function DELETE(
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

  const conn = await prisma.channelConnection.findUnique({
    where: { userId_provider: { userId: session.user.id, provider: provider.id } },
  });
  if (!conn) {
    return NextResponse.json({ error: "Not connected" }, { status: 404 });
  }

  if (provider.kind === "oauth" && provider.revoke && conn.accessToken) {
    try {
      await provider.revoke(await decrypt(conn.accessToken));
    } catch {
      // best-effort revoke; still delete locally
    }
  }

  await prisma.channelConnection.delete({ where: { id: conn.id } });
  return NextResponse.json({ ok: true });
}

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

function newToken(): string {
  return `mcp_${randomBytes(24).toString("hex")}`;
}

function mcpUrl(): string {
  return process.env.MCP_PUBLIC_URL ?? "http://localhost:3001/mcp";
}

/** GET /api/mcp-token — return the current user's MCP token (created on first call). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { mcpToken: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!user.mcpToken) {
    user = await prisma.user.update({
      where: { id: session.user.id },
      data: { mcpToken: newToken() },
      select: { mcpToken: true },
    });
  }
  return NextResponse.json({ token: user.mcpToken, mcpUrl: mcpUrl() });
}

/** POST /api/mcp-token — rotate the token (old one stops working immediately). */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.update({
    where: { id: session.user.id },
    data: { mcpToken: newToken() },
    select: { mcpToken: true },
  });
  return NextResponse.json({ token: user.mcpToken, mcpUrl: mcpUrl() });
}

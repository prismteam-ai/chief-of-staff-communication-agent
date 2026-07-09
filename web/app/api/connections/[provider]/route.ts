import { NextRequest, NextResponse } from "next/server";
import { proxy } from "@/lib/api";
import { prisma } from "@/lib/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const body = await req.text();
  const res = await proxy(`/api/connections/${encodeURIComponent(provider)}`, {
    method: "POST",
    body,
  });
  const text = await res.text();
  if (res.ok) {
    try {
      const s = JSON.parse(text);
      await prisma.connection.upsert({
        where: { provider },
        update: { mode: s.mode, connected: s.connected, detail: s.detail },
        create: { provider, mode: s.mode, connected: s.connected, detail: s.detail },
      });
    } catch {
      /* best-effort */
    }
  }
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

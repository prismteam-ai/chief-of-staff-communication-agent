import { NextRequest, NextResponse } from "next/server";
import { proxy } from "@/lib/api";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await proxy("/api/approve", { method: "POST", body });
  const text = await res.text();
  if (res.ok) {
    // Record the sent reply for answered / response-time tracking.
    try {
      const parsed = JSON.parse(body);
      const result = JSON.parse(text);
      await prisma.sentReply.create({
        data: {
          messageId: parsed.message_id,
          channel: parsed.channel,
          text: parsed.text,
          responseSeconds: result.response_seconds ?? null,
        },
      });
    } catch {
      /* best-effort logging */
    }
  }
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

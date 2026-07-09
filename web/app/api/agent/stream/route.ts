import { NextRequest } from "next/server";
import { proxy } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await proxy("/api/agent/stream", { method: "POST", body });
  // Pipe the SSE stream straight through to the browser.
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

import { proxy } from "@/lib/api";

export async function GET() {
  const res = await proxy("/api/connections");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

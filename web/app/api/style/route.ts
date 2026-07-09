import { proxy } from "@/lib/api";

export async function GET() {
  const res = await proxy("/api/style");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(req: Request) {
  const body = await req.text();
  const res = await proxy("/api/style", { method: "PUT", body });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

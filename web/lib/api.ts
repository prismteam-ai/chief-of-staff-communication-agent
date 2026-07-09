import { getToken } from "./session";

const BASE = process.env.COS_API_URL ?? "http://localhost:8000";

/** Proxy a request to the Python API, attaching the caller's session as a bearer token.
 *  Returns the raw Response so route handlers can stream (SSE) or forward JSON + status. */
export async function proxy(
  path: string,
  init: RequestInit & { rawToken?: string } = {}
): Promise<Response> {
  const token = init.rawToken ?? (await getToken());
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return fetch(`${BASE}${path}`, { ...init, headers, cache: "no-store" });
}

/** Proxy and parse JSON, throwing on non-2xx (for server components). */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await proxy(path, init);
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

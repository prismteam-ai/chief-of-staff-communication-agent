import { getCredentials } from "@/lib/connections";

const BASE = "https://app.asana.com/api/1.0";

export class AsanaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Authenticated GET against the Asana API using the user's stored PAT. */
export async function asanaGet<T>(
  userId: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const credentials = await getCredentials(userId, "asana");
  if (!credentials?.personalAccessToken) {
    throw new AsanaError("Asana is not connected", 400);
  }

  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${credentials.personalAccessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AsanaError(
      data.errors?.[0]?.message ?? `Asana API returned ${res.status}`,
      res.status === 401 ? 400 : 502
    );
  }
  return data.data as T;
}

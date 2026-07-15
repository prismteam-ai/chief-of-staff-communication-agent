import { getCredentials } from "@/lib/connections";

const BASE = "https://app.asana.com/api/1.0";

export class AsanaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** True when the deployment provides one shared org-wide Asana token. */
export function hasSharedAsanaToken(): boolean {
  return Boolean(process.env.ASANA_SHARED_TOKEN);
}

/**
 * Resolve the Asana PAT to use for a request. The shared organization token
 * (sourced from Azure Key Vault and injected as ASANA_SHARED_TOKEN) wins so
 * every user works against the same Asana instance; per-user stored
 * credentials remain as a fallback for self-hosted setups.
 */
export async function getAsanaToken(userId: string): Promise<string | null> {
  const shared = process.env.ASANA_SHARED_TOKEN;
  if (shared) return shared;
  const credentials = await getCredentials(userId, "asana");
  return credentials?.personalAccessToken ?? null;
}

/** Authenticated POST against the Asana API. */
export async function asanaPost<T>(
  userId: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = await getAsanaToken(userId);
  if (!token) {
    throw new AsanaError("Asana is not connected", 400);
  }

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: body }),
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
export async function asanaGet<T>(
  userId: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const token = await getAsanaToken(userId);
  if (!token) {
    throw new AsanaError("Asana is not connected", 400);
  }

  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
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

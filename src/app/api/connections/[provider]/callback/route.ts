import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { getProvider } from "@/lib/providers";
import { exchangeCode } from "@/lib/providers/oauth";
import { saveOAuthConnection } from "@/lib/connections";

function redirectToConnections(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/connections", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/** GET /api/connections/[provider]/callback — OAuth redirect target. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", req.nextUrl.origin));
  }

  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider || provider.kind !== "oauth") {
    return redirectToConnections(req, { error: "Unknown provider" });
  }

  const search = req.nextUrl.searchParams;
  if (search.get("error")) {
    return redirectToConnections(req, {
      error: `${provider.name}: ${search.get("error_description") ?? search.get("error")}`,
    });
  }

  const code = search.get("code");
  const state = search.get("state");
  const jar = await cookies();
  const cookieName = `oauth_state_${provider.id}`;
  const stored = jar.get(cookieName)?.value;
  jar.delete(cookieName);

  if (!code || !state || !stored) {
    return redirectToConnections(req, { error: "Missing OAuth state or code" });
  }
  let parsed: { state: string; verifier?: string };
  try {
    parsed = JSON.parse(stored);
  } catch {
    return redirectToConnections(req, { error: "Invalid OAuth state" });
  }
  if (parsed.state !== state) {
    return redirectToConnections(req, { error: "OAuth state mismatch" });
  }

  try {
    const tokens = await exchangeCode(provider, code, parsed.verifier);
    const test = await provider.testConnection(tokens.accessToken);
    await saveOAuthConnection(session.user.id, provider, tokens, test.label);
    return redirectToConnections(req, { connected: provider.id });
  } catch (err) {
    return redirectToConnections(req, {
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
}

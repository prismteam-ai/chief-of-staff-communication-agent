import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { getProvider } from "@/lib/providers";
import {
  buildAuthorizeUrl,
  generatePKCE,
  generateState,
  isConfigured,
} from "@/lib/providers/oauth";

/** GET /api/connections/[provider]/authorize — start the OAuth flow. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider || provider.kind !== "oauth") {
    return NextResponse.json({ error: "Unknown OAuth provider" }, { status: 404 });
  }
  if (!isConfigured(provider)) {
    return NextResponse.json(
      { error: `${provider.name} is not configured. Set ${provider.clientIdEnv} and ${provider.clientSecretEnv}.` },
      { status: 400 }
    );
  }

  const state = generateState();
  const pkce = provider.usePKCE ? generatePKCE() : undefined;
  const url = buildAuthorizeUrl(provider, state, pkce?.challenge);

  const jar = await cookies();
  jar.set(`oauth_state_${provider.id}`, JSON.stringify({ state, verifier: pkce?.verifier }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(url);
}

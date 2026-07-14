import { createHash, randomBytes } from "crypto";
import type { OAuthProviderConfig, TokenSet } from "./types";

/** Generic OAuth 2.0 authorization-code engine shared by all OAuth channels. */

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function redirectUri(provider: OAuthProviderConfig): string {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  return `${base}/api/connections/${provider.id}/callback`;
}

function clientId(p: OAuthProviderConfig): string {
  const v = process.env[p.clientIdEnv];
  if (!v) throw new Error(`Missing env var ${p.clientIdEnv} for ${p.name}`);
  return v;
}

function clientSecret(p: OAuthProviderConfig): string {
  const v = process.env[p.clientSecretEnv];
  if (!v) throw new Error(`Missing env var ${p.clientSecretEnv} for ${p.name}`);
  return v;
}

export function isConfigured(p: OAuthProviderConfig): boolean {
  return Boolean(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

export function buildAuthorizeUrl(
  p: OAuthProviderConfig,
  state: string,
  pkceChallenge?: string
): string {
  const url = new URL(p.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId(p));
  url.searchParams.set("redirect_uri", redirectUri(p));
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", state);
  if (p.usePKCE && pkceChallenge) {
    url.searchParams.set("code_challenge", pkceChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(p.extraAuthParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function tokenRequest(
  p: OAuthProviderConfig,
  params: Record<string, string>
): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (p.clientAuth === "basic") {
    headers.Authorization =
      "Basic " + Buffer.from(`${clientId(p)}:${clientSecret(p)}`).toString("base64");
  } else {
    body.set("client_id", clientId(p));
    body.set("client_secret", clientSecret(p));
  }

  const res = await fetch(p.tokenUrl, { method: "POST", headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${p.name} token endpoint error (${res.status}): ${
        data.error_description ?? data.error ?? JSON.stringify(data)
      }`
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000)
      : undefined,
    scope: data.scope,
  };
}

export async function exchangeCode(
  p: OAuthProviderConfig,
  code: string,
  pkceVerifier?: string
): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(p),
  };
  if (p.usePKCE && pkceVerifier) params.code_verifier = pkceVerifier;
  return tokenRequest(p, params);
}

export async function refreshAccessToken(
  p: OAuthProviderConfig,
  refreshToken: string
): Promise<TokenSet> {
  const tokens = await tokenRequest(p, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  // Some providers don't rotate the refresh token; keep the old one.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

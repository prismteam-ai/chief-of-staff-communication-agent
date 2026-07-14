import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/lib/crypto";
import {
  getProvider,
  type OAuthProviderConfig,
  type TokenSet,
} from "@/lib/providers";
import { refreshAccessToken } from "@/lib/providers/oauth";

/** Persist tokens from a completed OAuth flow. */
export async function saveOAuthConnection(
  userId: string,
  provider: OAuthProviderConfig,
  tokens: TokenSet,
  accountLabel?: string | null
) {
  const data = {
    status: "connected",
    accessToken: await encrypt(tokens.accessToken),
    refreshToken: tokens.refreshToken ? await encrypt(tokens.refreshToken) : null,
    scopes: tokens.scope ?? provider.scopes.join(" "),
    expiresAt: tokens.expiresAt ?? null,
    accountLabel: accountLabel ?? null,
    lastCheckAt: new Date(),
    lastError: null,
  };
  return prisma.channelConnection.upsert({
    where: { userId_provider: { userId, provider: provider.id } },
    create: { userId, provider: provider.id, ...data },
    update: data,
  });
}

/** Persist validated credentials for credential-based providers (WhatsApp, SMS). */
export async function saveCredentialConnection(
  userId: string,
  providerId: string,
  credentials: Record<string, string>,
  accountLabel?: string | null
) {
  const data = {
    status: "connected",
    credentials: await encrypt(JSON.stringify(credentials)),
    accountLabel: accountLabel ?? null,
    lastCheckAt: new Date(),
    lastError: null,
  };
  return prisma.channelConnection.upsert({
    where: { userId_provider: { userId, provider: providerId } },
    create: { userId, provider: providerId, ...data },
    update: data,
  });
}

/** Decrypt stored credentials for a credential-based connection. */
export async function getCredentials(
  userId: string,
  providerId: string
): Promise<Record<string, string> | null> {
  const conn = await prisma.channelConnection.findUnique({
    where: { userId_provider: { userId, provider: providerId } },
  });
  if (!conn?.credentials) return null;
  return JSON.parse(await decrypt(conn.credentials));
}

/**
 * Return a valid access token for an OAuth connection, refreshing (and
 * persisting the rotated tokens) when expired. This is the entry point the
 * future AI agent layer will use to act on a channel.
 */
export async function getFreshAccessToken(
  userId: string,
  providerId: string
): Promise<string | null> {
  const provider = getProvider(providerId);
  if (!provider || provider.kind !== "oauth") return null;

  const conn = await prisma.channelConnection.findUnique({
    where: { userId_provider: { userId, provider: providerId } },
  });
  if (!conn?.accessToken) return null;

  const notExpired =
    !conn.expiresAt || conn.expiresAt.getTime() > Date.now() + 60_000;
  if (notExpired) return decrypt(conn.accessToken);

  if (!conn.refreshToken) {
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { status: "expired", lastError: "Access token expired and no refresh token available" },
    });
    return null;
  }

  try {
    const tokens = await refreshAccessToken(provider, await decrypt(conn.refreshToken));
    await saveOAuthConnection(userId, provider, tokens, conn.accountLabel);
    return tokens.accessToken;
  } catch (err) {
    await prisma.channelConnection.update({
      where: { id: conn.id },
      data: { status: "error", lastError: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

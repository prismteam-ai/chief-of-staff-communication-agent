import type { OAuthProviderConfig } from "./types";

export const x: OAuthProviderConfig = {
  kind: "oauth",
  id: "x",
  name: "X",
  description: "Read and post on X (Twitter) on your behalf.",
  authorizeUrl: "https://twitter.com/i/oauth2/authorize",
  tokenUrl: "https://api.twitter.com/2/oauth2/token",
  scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
  clientIdEnv: "X_CLIENT_ID",
  clientSecretEnv: "X_CLIENT_SECRET",
  usePKCE: true,
  clientAuth: "basic",
  async testConnection(accessToken) {
    const res = await fetch("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, error: `X API returned ${res.status}` };
    const data = await res.json();
    return { ok: true, label: data.data?.username ? `@${data.data.username}` : undefined };
  },
  async revoke(accessToken) {
    const id = process.env.X_CLIENT_ID ?? "";
    const secret = process.env.X_CLIENT_SECRET ?? "";
    await fetch("https://api.twitter.com/2/oauth2/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      },
      body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }),
    }).catch(() => {});
  },
};

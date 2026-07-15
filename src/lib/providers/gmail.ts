import type { OAuthProviderConfig } from "./types";

export const gmail: OAuthProviderConfig = {
  kind: "oauth",
  id: "gmail",
  name: "Gmail",
  description: "Read and send email through your Google account.",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  clientIdEnv: "GMAIL_CLIENT_ID",
  clientSecretEnv: "GMAIL_CLIENT_SECRET",
  clientAuth: "body",
  extraAuthParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  },
  async testConnection(accessToken) {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, error: `Gmail API returned ${res.status}` };
    const data = await res.json();
    return { ok: true, label: data.emailAddress };
  },
  async revoke(accessToken) {
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
      { method: "POST" }
    ).catch(() => {});
  },
};

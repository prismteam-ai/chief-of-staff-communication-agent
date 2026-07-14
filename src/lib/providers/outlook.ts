import type { OAuthProviderConfig } from "./types";

export const outlook: OAuthProviderConfig = {
  kind: "oauth",
  id: "outlook",
  name: "Outlook",
  description: "Read and send email through Microsoft 365 / Outlook.",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Mail.Send",
  ],
  clientIdEnv: "OUTLOOK_CLIENT_ID",
  clientSecretEnv: "OUTLOOK_CLIENT_SECRET",
  clientAuth: "body",
  async testConnection(accessToken) {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, error: `Microsoft Graph returned ${res.status}` };
    const data = await res.json();
    return { ok: true, label: data.mail ?? data.userPrincipalName };
  },
};

import type { OAuthProviderConfig } from "./types";

export const linkedin: OAuthProviderConfig = {
  kind: "oauth",
  id: "linkedin",
  name: "LinkedIn",
  description: "Post updates and read your LinkedIn profile.",
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  scopes: ["openid", "profile", "email", "w_member_social"],
  clientIdEnv: "LINKEDIN_CLIENT_ID",
  clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
  clientAuth: "body",
  async testConnection(accessToken) {
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, error: `LinkedIn API returned ${res.status}` };
    const data = await res.json();
    return { ok: true, label: data.email ?? data.name };
  },
};

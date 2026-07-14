import type { CredentialProviderConfig } from "./types";

export const asana: CredentialProviderConfig = {
  kind: "credentials",
  id: "asana",
  name: "Asana",
  description: "Pull your workspaces, projects and tasks from Asana.",
  helpUrl: "https://app.asana.com/0/my-apps",
  fields: [
    {
      name: "personalAccessToken",
      label: "Personal Access Token",
      placeholder: "1/1234567890:abcdef…",
      secret: true,
    },
  ],
  async testConnection(credentials) {
    const res = await fetch("https://app.asana.com/api/1.0/users/me", {
      headers: { Authorization: `Bearer ${credentials.personalAccessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: data.errors?.[0]?.message ?? `Asana API returned ${res.status}`,
      };
    }
    return { ok: true, label: data.data?.email ?? data.data?.name };
  },
};

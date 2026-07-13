import type { CredentialProviderConfig } from "./types";

export const whatsapp: CredentialProviderConfig = {
  kind: "credentials",
  id: "whatsapp",
  name: "WhatsApp",
  description:
    "Send and receive WhatsApp messages via the Meta WhatsApp Business Cloud API.",
  helpUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  fields: [
    {
      name: "accessToken",
      label: "System User Access Token",
      placeholder: "EAAG...",
      secret: true,
    },
    {
      name: "phoneNumberId",
      label: "Phone Number ID",
      placeholder: "1234567890",
    },
    {
      name: "businessAccountId",
      label: "WhatsApp Business Account ID",
      placeholder: "1234567890",
    },
  ],
  async testConnection(credentials) {
    const { accessToken, phoneNumberId } = credentials;
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(phoneNumberId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error?.message ?? `Meta API returned ${res.status}` };
    }
    return { ok: true, label: data.display_phone_number };
  },
};

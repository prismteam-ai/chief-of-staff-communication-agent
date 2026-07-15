import type { CredentialProviderConfig } from "./types";

export const sms: CredentialProviderConfig = {
  kind: "credentials",
  id: "sms",
  name: "SMS",
  description: "Send and receive SMS via Twilio.",
  helpUrl: "https://www.twilio.com/docs/iam/api-keys",
  fields: [
    { name: "accountSid", label: "Account SID", placeholder: "AC..." },
    { name: "authToken", label: "Auth Token", secret: true },
    { name: "phoneNumber", label: "Twilio Phone Number", placeholder: "+15551234567" },
  ],
  async testConnection(credentials) {
    const { accountSid, authToken, phoneNumber } = credentials;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
      {
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        },
      }
    );
    if (!res.ok) return { ok: false, error: `Twilio API returned ${res.status}` };
    return { ok: true, label: phoneNumber };
  },
};

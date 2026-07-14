import { getCredentials, getFreshAccessToken } from "@/lib/connections";

export interface SendInput {
  userId: string;
  recipient: string;
  subject?: string | null;
  body: string;
  /** external id of the message being replied to (for threading, e.g. X tweet id) */
  inReplyToExternalId?: string | null;
}

export type Sender = (input: SendInput) => Promise<void>;

async function requireToken(userId: string, provider: string): Promise<string> {
  const token = await getFreshAccessToken(userId, provider);
  if (!token) throw new Error(`${provider}: no valid access token — reconnect the channel`);
  return token;
}

const sendGmail: Sender = async ({ userId, recipient, subject, body }) => {
  const token = await requireToken(userId, "gmail");
  const raw = [
    `To: ${recipient}`,
    `Subject: ${subject ?? ""}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
    }
  );
  if (!res.ok) throw new Error(`Gmail send failed (${res.status})`);
};

const sendOutlook: Sender = async ({ userId, recipient, subject, body }) => {
  const token = await requireToken(userId, "outlook");
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: subject ?? "",
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: recipient } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Outlook send failed (${res.status}): ${err.error?.message ?? ""}`);
  }
};

const sendSms: Sender = async ({ userId, recipient, body }) => {
  const creds = await getCredentials(userId, "sms");
  if (!creds) throw new Error("SMS: Twilio not connected");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: recipient, From: creds.phoneNumber, Body: body }),
    }
  );
  if (!res.ok) throw new Error(`Twilio send failed (${res.status})`);
};

const sendWhatsapp: Sender = async ({ userId, recipient, body }) => {
  const creds = await getCredentials(userId, "whatsapp");
  if (!creds) throw new Error("WhatsApp not connected");
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${encodeURIComponent(creds.phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient.replace(/^\+/, ""),
        type: "text",
        text: { body },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp send failed (${res.status}): ${err.error?.message ?? ""}`);
  }
};

const sendX: Sender = async ({ userId, body, inReplyToExternalId }) => {
  const token = await requireToken(userId, "x");
  const payload: { text: string; reply?: { in_reply_to_tweet_id: string } } = {
    text: body.slice(0, 280),
  };
  if (inReplyToExternalId) {
    payload.reply = { in_reply_to_tweet_id: inReplyToExternalId };
  }
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`X post failed (${res.status}): ${err.detail ?? err.title ?? ""}`);
  }
};

/** Channel senders. linkedin/asana are not sendable channels. */
export const senders: Record<string, Sender | undefined> = {
  gmail: sendGmail,
  outlook: sendOutlook,
  sms: sendSms,
  whatsapp: sendWhatsapp,
  x: sendX,
};

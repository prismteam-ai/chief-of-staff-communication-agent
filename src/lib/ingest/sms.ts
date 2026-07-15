import type { IngestContext, IngestResult, NormalizedMessage } from "./types";

interface TwilioMessage {
  sid: string;
  from?: string;
  to?: string;
  body?: string;
  date_sent?: string;
  date_created?: string;
  direction?: string;
  num_media?: string;
}

/** Ingest SMS history via the Twilio Messages API. Cursor = ISO date of newest seen. */
export async function ingestSms(ctx: IngestContext): Promise<IngestResult> {
  const { credentials, cursor } = ctx;
  if (!credentials) throw new Error("SMS: missing Twilio credentials");
  const { accountSid, authToken } = credentials;

  let url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json?PageSize=100`;
  if (cursor) url += `&DateSent%3E=${encodeURIComponent(cursor.slice(0, 10))}`;

  const res = await fetch(url, {
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
    },
  });
  if (!res.ok) throw new Error(`SMS: Twilio returned ${res.status}`);
  const data = await res.json();
  const items: TwilioMessage[] = data.messages ?? [];

  const messages: NormalizedMessage[] = [];
  let newest = cursor ?? null;

  for (const m of items) {
    const sentAt = new Date(m.date_sent ?? m.date_created ?? Date.now());
    const iso = sentAt.toISOString();
    if (cursor && iso <= cursor) continue;
    if (!newest || iso > newest) newest = iso;

    const isOutbound = (m.direction ?? "").startsWith("outbound");
    const counterpart = isOutbound ? m.to : m.from;

    messages.push({
      externalId: m.sid,
      // Thread SMS by counterpart phone number
      threadExternalId: counterpart ?? null,
      threadSubject: counterpart ?? null,
      subject: null,
      snippet: m.body?.slice(0, 200) ?? null,
      body: m.body ?? null,
      sentAt,
      isOutbound,
      participants: [
        ...(m.from ? [{ role: "from" as const, address: m.from }] : []),
        ...(m.to ? [{ role: "to" as const, address: m.to }] : []),
      ],
      attachments:
        Number(m.num_media ?? 0) > 0
          ? Array.from({ length: Number(m.num_media) }, (_, i) => ({
              filename: `media-${i + 1}`,
              mimeType: null,
              sizeBytes: null,
            }))
          : [],
    });
  }

  return { messages, nextCursor: newest };
}

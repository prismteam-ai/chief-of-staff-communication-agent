import type { IngestContext, IngestResult, NormalizedMessage, NormalizedParticipant } from "./types";

interface GmailHeader { name: string; value: string }
interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart & { headers?: GmailHeader[] };
}

function header(headers: GmailHeader[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** Parse "Name <a@b.com>, c@d.com" into participants. */
function parseAddressList(
  role: NormalizedParticipant["role"],
  value: string | null
): NormalizedParticipant[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
      if (match) return { role, name: match[1]?.trim() || null, address: match[2].trim() };
      return { role, name: null, address: part };
    });
}

function extractBody(part: GmailPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = extractBody(child);
    if (found) return found;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url")
      .toString("utf8")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return null;
}

function extractAttachments(part: GmailPart | undefined) {
  const out: { externalId: string | null; filename: string; mimeType: string | null; sizeBytes: number | null }[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.push({
        externalId: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType ?? null,
        sizeBytes: p.body.size ?? null,
      });
    }
    p.parts?.forEach(walk);
  };
  walk(part);
  return out;
}

/** Ingest Gmail via the Gmail API. Cursor = epoch-seconds of newest seen message. */
export async function ingestGmail(ctx: IngestContext): Promise<IngestResult> {
  const { accessToken, cursor } = ctx;
  if (!accessToken) throw new Error("Gmail: missing access token");
  const headers = { Authorization: `Bearer ${accessToken}` };

  let listUrl =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50";
  if (cursor) listUrl += `&q=after:${cursor}`;

  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) throw new Error(`Gmail: list returned ${listRes.status}`);
  const list = await listRes.json();
  const ids: { id: string }[] = list.messages ?? [];

  const messages: NormalizedMessage[] = [];
  let newestEpoch = cursor ? Number(cursor) : 0;

  for (const { id } of ids) {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers }
    );
    if (!res.ok) continue;
    const m: GmailMessage = await res.json();
    const h = m.payload?.headers;
    const sentAt = new Date(Number(m.internalDate ?? Date.now()));
    newestEpoch = Math.max(newestEpoch, Math.floor(sentAt.getTime() / 1000));

    messages.push({
      externalId: m.id,
      threadExternalId: m.threadId ?? null,
      threadSubject: header(h, "Subject"),
      subject: header(h, "Subject"),
      snippet: m.snippet ?? null,
      body: extractBody(m.payload),
      sentAt,
      isOutbound: (m.labelIds ?? []).includes("SENT"),
      participants: [
        ...parseAddressList("from", header(h, "From")),
        ...parseAddressList("to", header(h, "To")),
        ...parseAddressList("cc", header(h, "Cc")),
        ...parseAddressList("bcc", header(h, "Bcc")),
      ],
      attachments: extractAttachments(m.payload),
    });
  }

  return { messages, nextCursor: newestEpoch ? String(newestEpoch) : cursor ?? null };
}

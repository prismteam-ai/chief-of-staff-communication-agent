import type { IngestContext, IngestResult, NormalizedMessage, NormalizedParticipant } from "./types";

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
}

function mapRecipients(
  role: NormalizedParticipant["role"],
  recipients?: GraphRecipient[]
): NormalizedParticipant[] {
  return (recipients ?? [])
    .filter((r) => r.emailAddress?.address)
    .map((r) => ({
      role,
      name: r.emailAddress?.name ?? null,
      address: r.emailAddress!.address!,
    }));
}

/** Ingest Outlook mail via Microsoft Graph. Cursor = ISO timestamp of newest seen message. */
export async function ingestOutlook(ctx: IngestContext): Promise<IngestResult> {
  const { accessToken, cursor, accountLabel } = ctx;
  if (!accessToken) throw new Error("Outlook: missing access token");

  const select =
    "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,isDraft";
  let url =
    `https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=${select}`;
  if (cursor) {
    url += `&$filter=receivedDateTime gt ${cursor}`;
  }

  const messages: NormalizedMessage[] = [];
  let newestSeen = cursor ?? null;
  let pages = 0;

  while (url && pages < 4) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Outlook: Graph returned ${res.status}: ${err.error?.message ?? ""}`);
    }
    const data = await res.json();
    const items: GraphMessage[] = data.value ?? [];

    for (const m of items) {
      if (m.isDraft) continue;
      const sentAt = new Date(m.receivedDateTime ?? m.sentDateTime ?? Date.now());
      if (!newestSeen || sentAt.toISOString() > newestSeen) {
        newestSeen = sentAt.toISOString();
      }

      const attachments = m.hasAttachments
        ? await fetchAttachments(accessToken, m.id)
        : [];

      const fromAddr = m.from?.emailAddress?.address ?? "";
      messages.push({
        externalId: m.id,
        threadExternalId: m.conversationId ?? null,
        threadSubject: m.subject ?? null,
        subject: m.subject ?? null,
        snippet: m.bodyPreview ?? null,
        body: m.body?.content ?? null,
        sentAt,
        isOutbound:
          Boolean(accountLabel) &&
          fromAddr.toLowerCase() === accountLabel!.toLowerCase(),
        participants: [
          ...mapRecipients("from", m.from ? [m.from] : []),
          ...mapRecipients("to", m.toRecipients),
          ...mapRecipients("cc", m.ccRecipients),
          ...mapRecipients("bcc", m.bccRecipients),
        ],
        attachments,
      });
    }

    url = data["@odata.nextLink"] ?? "";
    pages++;
  }

  return { messages, nextCursor: newestSeen };
}

async function fetchAttachments(accessToken: string, messageId: string) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments?$select=id,name,contentType,size`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  interface GraphAttachment { id: string; name?: string; contentType?: string; size?: number }
  return ((data.value ?? []) as GraphAttachment[]).map((a) => ({
    externalId: a.id,
    filename: a.name ?? "attachment",
    mimeType: a.contentType ?? null,
    sizeBytes: a.size ?? null,
  }));
}

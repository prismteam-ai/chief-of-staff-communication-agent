import { prisma } from "@/lib/prisma";

export interface RelatedMessage {
  id: string;
  threadId: string | null;
  provider: string;
  subject: string | null;
  snippet: string | null;
  sentAt: Date;
  isOutbound: boolean;
  from: { name: string | null; address: string } | null;
  reasons: string[]; // why it's linked: same person / same topic / same project
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "about",
  "have", "will", "would", "could", "please", "thanks", "thank", "hello",
  "update", "regarding", "meeting", "email", "message",
]);

function topicTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/^(re|fwd?):\s*/gi, "")
      .split(/\W+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

/**
 * Link messages across channels that belong to the same person, topic, or
 * Asana project. Heuristic, computed on demand:
 *  - same person: any participant address or name shared with the source
 *  - same topic: ≥2 meaningful subject/snippet keywords in common
 */
export async function findRelatedMessages(
  userId: string,
  messageId: string,
  limit = 15
): Promise<RelatedMessage[]> {
  const source = await prisma.message.findFirst({
    where: { id: messageId, userId },
    include: { participants: true },
  });
  if (!source) throw new Error("Message not found");

  const addresses = source.participants.map((p) => p.address.toLowerCase()).filter(Boolean);
  const names = source.participants
    .map((p) => p.name?.toLowerCase().trim())
    .filter((n): n is string => Boolean(n && n.length > 3));
  const srcTokens = topicTokens(`${source.subject ?? ""} ${source.snippet ?? ""}`);

  const candidates = await prisma.message.findMany({
    where: {
      userId,
      id: { not: source.id },
      threadId: source.threadId ? { not: source.threadId } : undefined,
    },
    orderBy: { sentAt: "desc" },
    take: 300,
    include: { participants: true },
  });

  const related: RelatedMessage[] = [];
  for (const m of candidates) {
    const reasons: string[] = [];

    const samePerson = m.participants.some(
      (p) =>
        addresses.includes(p.address.toLowerCase()) ||
        (p.name && names.includes(p.name.toLowerCase().trim()))
    );
    if (samePerson) reasons.push("same person");

    const tokens = topicTokens(`${m.subject ?? ""} ${m.snippet ?? ""}`);
    let overlap = 0;
    for (const t of tokens) if (srcTokens.has(t)) overlap++;
    if (overlap >= 2) reasons.push("same topic");

    if (!reasons.length) continue;
    const from = m.participants.find((p) => p.role === "from");
    related.push({
      id: m.id,
      threadId: m.threadId,
      provider: m.provider,
      subject: m.subject,
      snippet: m.snippet,
      sentAt: m.sentAt,
      isOutbound: m.isOutbound,
      from: from ? { name: from.name, address: from.address } : null,
      reasons,
    });
    if (related.length >= limit) break;
  }

  // cross-channel matches first, then recency
  related.sort((a, b) => {
    const cross = Number(b.provider !== source.provider) - Number(a.provider !== source.provider);
    return cross || b.sentAt.getTime() - a.sentAt.getTime();
  });
  return related;
}

import type { IngestContext, IngestResult, NormalizedMessage } from "./types";

interface Tweet {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  attachments?: { media_keys?: string[] };
}
interface TwitterUser { id: string; username?: string; name?: string }

/** Ingest X mentions (DM access requires elevated API tiers). Cursor = newest tweet id. */
export async function ingestX(ctx: IngestContext): Promise<IngestResult> {
  const { accessToken, cursor } = ctx;
  if (!accessToken) throw new Error("X: missing access token");
  const headers = { Authorization: `Bearer ${accessToken}` };

  const meRes = await fetch("https://api.twitter.com/2/users/me", { headers });
  if (!meRes.ok) throw new Error(`X: users/me returned ${meRes.status}`);
  const me = (await meRes.json()).data as TwitterUser;

  let url =
    `https://api.twitter.com/2/users/${me.id}/mentions?max_results=50` +
    `&tweet.fields=created_at,author_id,conversation_id,attachments&expansions=author_id`;
  if (cursor) url += `&since_id=${cursor}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`X: mentions returned ${res.status}`);
  const data = await res.json();
  const tweets: Tweet[] = data.data ?? [];
  const users: TwitterUser[] = data.includes?.users ?? [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const messages: NormalizedMessage[] = tweets.map((t) => {
    const author = t.author_id ? userById.get(t.author_id) : undefined;
    return {
      externalId: t.id,
      threadExternalId: t.conversation_id ?? null,
      threadSubject: null,
      subject: null,
      snippet: t.text?.slice(0, 200) ?? null,
      body: t.text ?? null,
      sentAt: new Date(t.created_at ?? Date.now()),
      isOutbound: false,
      participants: [
        {
          role: "from" as const,
          name: author?.name ?? null,
          address: author?.username ? `@${author.username}` : t.author_id ?? "unknown",
        },
        {
          role: "to" as const,
          name: null,
          address: me.username ? `@${me.username}` : me.id,
        },
      ],
      attachments: (t.attachments?.media_keys ?? []).map((key, i) => ({
        externalId: key,
        filename: `media-${i + 1}`,
        mimeType: null,
        sizeBytes: null,
      })),
    };
  });

  const newestId = tweets.length
    ? tweets.reduce((max, t) => (BigInt(t.id) > BigInt(max) ? t.id : max), tweets[0].id)
    : cursor ?? null;

  return { messages, nextCursor: newestId };
}

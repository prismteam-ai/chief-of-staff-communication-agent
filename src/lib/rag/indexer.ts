import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { asanaGet, hasSharedAsanaToken } from "@/lib/asana";
import { embed } from "./embeddings";

/**
 * Knowledge indexer: turns the four RAG sources into KnowledgeChunk rows.
 *  - communication history (recent inbound/outbound messages)
 *  - Asana context (projects and tasks with notes)
 *  - user preferences (agent configurations + preference notes)
 *  - organizational knowledge (user-authored notes)
 * Chunks are upserted idempotently and embedded when a model is configured.
 */

const MAX_CHUNK_CHARS = 1500;

interface ChunkInput {
  source: string;
  sourceId: string;
  title: string | null;
  content: string;
}

export interface IndexSummary {
  scanned: number;
  written: number;
  embedded: number;
}

export async function indexUserKnowledge(userId: string): Promise<IndexSummary> {
  const chunks: ChunkInput[] = [];
  chunks.push(...(await messageChunks(userId)));
  chunks.push(...(await asanaChunks(userId)));
  chunks.push(...(await preferenceChunks(userId)));
  chunks.push(...(await orgChunks(userId)));

  let written = 0;
  const toEmbed: { id: string; content: string }[] = [];

  for (const c of chunks) {
    const content = c.content.slice(0, MAX_CHUNK_CHARS).trim();
    if (!content) continue;
    const existing = await prisma.knowledgeChunk.findUnique({
      where: { userId_source_sourceId: { userId, source: c.source, sourceId: c.sourceId } },
      select: { id: true, content: true, embedding: true },
    });
    if (existing && existing.content === content && existing.embedding !== null) continue;
    if (existing && existing.content === content) {
      toEmbed.push({ id: existing.id, content });
      continue;
    }
    const row = existing
      ? await prisma.knowledgeChunk.update({
          where: { id: existing.id },
          data: { title: c.title, content, embedding: Prisma.JsonNull },
        })
      : await prisma.knowledgeChunk.create({
          data: { userId, source: c.source, sourceId: c.sourceId, title: c.title, content },
        });
    written++;
    toEmbed.push({ id: row.id, content });
  }

  // prune org/preference chunks whose source item was deleted
  const items = await prisma.knowledgeItem.findMany({ where: { userId }, select: { id: true } });
  const itemIds = new Set(items.map((i) => i.id));
  const stale = await prisma.knowledgeChunk.findMany({
    where: { userId, source: { in: ["org", "preference"] } },
    select: { id: true, sourceId: true },
  });
  const staleIds = stale.filter((s) => !itemIds.has(s.sourceId)).map((s) => s.id);
  if (staleIds.length) {
    await prisma.knowledgeChunk.deleteMany({ where: { id: { in: staleIds } } });
  }

  // embed in batches when configured
  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += 16) {
    const batch = toEmbed.slice(i, i + 16);
    const vectors = await embed(batch.map((b) => b.content));
    if (!vectors) break;
    for (let j = 0; j < batch.length; j++) {
      await prisma.knowledgeChunk.update({
        where: { id: batch[j].id },
        data: { embedding: vectors[j] },
      });
      embedded++;
    }
  }

  return { scanned: chunks.length, written, embedded };
}

async function messageChunks(userId: string): Promise<ChunkInput[]> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const messages = await prisma.message.findMany({
    where: { userId, sentAt: { gte: since } },
    orderBy: { sentAt: "desc" },
    take: 500,
    select: {
      id: true,
      provider: true,
      subject: true,
      body: true,
      snippet: true,
      sentAt: true,
      isOutbound: true,
      participants: { where: { role: "from" }, select: { name: true, address: true } },
    },
  });
  return messages.map((m) => {
    const from = m.participants[0];
    const who = m.isOutbound ? "You" : from?.name ?? from?.address ?? "Unknown";
    return {
      source: "message",
      sourceId: m.id,
      title: m.subject ?? `${m.provider} message`,
      content:
        `[${m.provider}] ${who} on ${m.sentAt.toISOString().slice(0, 10)}` +
        (m.subject ? ` — ${m.subject}` : "") +
        `\n${(m.body ?? m.snippet ?? "").slice(0, 1200)}`,
    };
  });
}

async function asanaChunks(userId: string): Promise<ChunkInput[]> {
  if (!hasSharedAsanaToken()) {
    const conn = await prisma.channelConnection.findUnique({
      where: { userId_provider: { userId, provider: "asana" } },
      select: { status: true },
    });
    if (!conn || conn.status !== "connected") return [];
  }

  try {
    const workspaces = await asanaGet<{ gid: string }[]>(userId, "/workspaces?limit=5");
    const ws = workspaces[0]?.gid;
    if (!ws) return [];
    const projects = await asanaGet<{ gid: string; name: string; notes?: string }[]>(
      userId,
      `/projects?workspace=${ws}&archived=false&limit=50&opt_fields=name,notes`
    );

    const chunks: ChunkInput[] = [];
    for (const p of projects) {
      const tasks = await asanaGet<
        { gid: string; name: string; notes?: string; completed: boolean; due_on?: string | null; assignee?: { name?: string } | null }[]
      >(
        userId,
        `/projects/${p.gid}/tasks?limit=100&opt_fields=name,notes,completed,due_on,assignee.name`
      );
      chunks.push({
        source: "asana_project",
        sourceId: p.gid,
        title: p.name,
        content:
          `Asana project "${p.name}". ${p.notes ?? ""}\nTasks: ` +
          tasks
            .map(
              (t) =>
                `${t.name} (${t.completed ? "done" : t.due_on ? `due ${t.due_on}` : "open"}${t.assignee?.name ? `, ${t.assignee.name}` : ""})`
            )
            .join("; "),
      });
      for (const t of tasks) {
        if (!t.notes?.trim()) continue;
        chunks.push({
          source: "asana_task",
          sourceId: t.gid,
          title: t.name,
          content: `Asana task "${t.name}" in project "${p.name}" (${t.completed ? "completed" : "open"}${t.due_on ? `, due ${t.due_on}` : ""}).\n${t.notes.slice(0, 1000)}`,
        });
      }
    }
    return chunks;
  } catch {
    return []; // Asana unreachable — index the rest
  }
}

async function preferenceChunks(userId: string): Promise<ChunkInput[]> {
  const [agents, prefs] = await Promise.all([
    prisma.agent.findMany({ where: { userId } }),
    prisma.knowledgeItem.findMany({ where: { userId, kind: "preference" } }),
  ]);
  const chunks: ChunkInput[] = agents.map((a) => ({
    source: "agent",
    sourceId: a.id,
    title: `Agent: ${a.name}`,
    content:
      `Agent "${a.name}" — style: ${a.communicationStyle}, tone: ${a.toneOfVoice}, mode: ${a.mode}, channels: ${a.channels.join(", ") || "none"}.` +
      (a.description ? ` Responsibility: ${a.description}.` : "") +
      (a.customInstructions ? ` Instructions: ${a.customInstructions}` : ""),
  }));
  chunks.push(
    ...prefs.map((p) => ({
      source: "preference",
      sourceId: p.id,
      title: p.title,
      content: `User preference — ${p.title}: ${p.content}`,
    }))
  );
  return chunks;
}

async function orgChunks(userId: string): Promise<ChunkInput[]> {
  const items = await prisma.knowledgeItem.findMany({ where: { userId, kind: "org" } });
  return items.map((i) => ({
    source: "org",
    sourceId: i.id,
    title: i.title,
    content: `${i.title}: ${i.content}`,
  }));
}

import { prisma } from "@/lib/prisma";
import { embed, cosine } from "./embeddings";

/**
 * Retriever: hybrid search over the knowledge index.
 * Vector similarity when embeddings exist, blended with lexical TF-IDF so
 * retrieval works (and stays grounded on exact names) without an embedding model.
 */

export interface RetrievedChunk {
  source: string;
  sourceId: string;
  title: string | null;
  content: string;
  score: number;
}

const SOURCE_LABEL: Record<string, string> = {
  message: "Communication history",
  asana_project: "Asana project",
  asana_task: "Asana task",
  preference: "User preference",
  org: "Organizational knowledge",
  agent: "Agent configuration",
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
}

export async function retrieve(
  userId: string,
  query: string,
  opts: { k?: number; sources?: string[]; excludeSourceIds?: string[] } = {}
): Promise<RetrievedChunk[]> {
  const k = opts.k ?? 6;
  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      userId,
      ...(opts.sources ? { source: { in: opts.sources } } : {}),
      ...(opts.excludeSourceIds ? { sourceId: { notIn: opts.excludeSourceIds } } : {}),
    },
    select: { source: true, sourceId: true, title: true, content: true, embedding: true },
    take: 2000,
  });
  if (!chunks.length) return [];

  // lexical TF-IDF
  const qTerms = tokenize(query);
  const docTokens = chunks.map((c) => tokenize(`${c.title ?? ""} ${c.content}`));
  const df: Record<string, number> = {};
  for (const term of new Set(qTerms)) {
    df[term] = docTokens.filter((toks) => toks.includes(term)).length;
  }
  const n = chunks.length;
  const lexical = docTokens.map((toks) => {
    let s = 0;
    for (const term of qTerms) {
      const tf = toks.filter((t) => t === term).length;
      if (tf && df[term]) s += (tf / toks.length) * Math.log(1 + n / df[term]);
    }
    return s;
  });
  const maxLex = Math.max(...lexical, 1e-9);

  // vector similarity (only when both the query and chunk have embeddings)
  let vector: number[] | null = null;
  const qVec = await embed([query]);
  if (qVec) vector = qVec[0];

  const scored = chunks.map((c, i) => {
    const lex = lexical[i] / maxLex;
    const vec =
      vector && Array.isArray(c.embedding) ? cosine(vector, c.embedding as number[]) : null;
    const score = vec !== null ? 0.65 * vec + 0.35 * lex : lex;
    return {
      source: c.source,
      sourceId: c.sourceId,
      title: c.title,
      content: c.content,
      score,
    };
  });

  return scored
    .filter((c) => c.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Format retrieved chunks as a context block for the draft prompt. */
export function formatContext(chunks: RetrievedChunk[]): string | null {
  if (!chunks.length) return null;
  return chunks
    .map((c) => `[${SOURCE_LABEL[c.source] ?? c.source}${c.title ? `: ${c.title}` : ""}]\n${c.content}`)
    .join("\n\n");
}

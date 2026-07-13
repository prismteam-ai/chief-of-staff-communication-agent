/**
 * Embeddings for the RAG layer.
 * Uses Azure OpenAI when AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY /
 * AZURE_OPENAI_EMBEDDING_DEPLOYMENT are set; otherwise returns null and the
 * retriever falls back to lexical (TF-IDF) scoring so RAG works without keys.
 */

export function embeddingsConfigured(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
      process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
  );
}

export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!embeddingsConfigured() || texts.length === 0) return null;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/$/, "");
  const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT!;
  const res = await fetch(
    `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=2024-06-01`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.AZURE_OPENAI_API_KEY!,
      },
      body: JSON.stringify({ input: texts.map((t) => t.slice(0, 8000)) }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.data
    .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    .map((d: { embedding: number[] }) => d.embedding);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

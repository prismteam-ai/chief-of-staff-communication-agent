import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { embedText, EMBED_INPUT_TYPE, type RetrievalIndex, type SearchHit } from '@chief-of-staff/rag';

/**
 * `retrieveContext` tool (design.md §5 tool list). Embeds the query with Bedrock Cohere Embed v4
 * (reusing the RAG package's `embedText` — the sanctioned embeddings-only Bedrock exception; this
 * package adds NO second raw Bedrock client) and runs an account-scoped hybrid search over the
 * knowledge layer.
 *
 * The `accountId` is a PERMISSION BOUNDARY, not a convenience filter (design.md §10, and the RAG
 * package's own `SearchOptions.accountId` doc): a retrieval for account A must never surface account
 * B's chunks. It is bound at construction time from the communication being triaged — it is NOT a
 * tool parameter the model can set, so the model cannot widen its own retrieval scope by asking for
 * a different account. The model only chooses the query text and topK.
 */

export const RETRIEVE_CONTEXT_MAX_TOP_K = 10;
const DEFAULT_TOP_K = 5;

/** One retrieval hit shaped for the model to reason over (a subset of `SearchHit`). */
export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  textForContext: string;
  score: number;
  channel: string;
  sourceType: string;
  topic?: string;
  project?: string;
}

export function toRetrievedChunk(hit: SearchHit): RetrievedChunk {
  return {
    chunkId: hit.chunkId,
    sourceId: hit.sourceId,
    textForContext: hit.textForContext,
    score: hit.score,
    channel: hit.metadata.channel,
    sourceType: hit.metadata.sourceType,
    topic: hit.metadata.topic,
    project: hit.metadata.project,
  };
}

export interface RetrieveContextDeps {
  retrievalIndex: RetrievalIndex;
  /** The account being triaged — the permission boundary, bound at construction (not model-set). */
  accountId: string;
  /** Injectable embedder so tests never call Bedrock; defaults to the real Cohere Embed v4 helper. */
  embed?: (text: string) => Promise<number[]>;
}

/**
 * Runs the account-scoped retrieval and returns structured hits. Exposed separately from the `tool`
 * wrapper so unit tests can exercise the permission boundary directly without the AI SDK envelope.
 */
export async function runRetrieveContext(
  deps: RetrieveContextDeps,
  input: { query: string; topK?: number },
): Promise<{ hits: RetrievedChunk[] }> {
  const query = input.query.trim();
  if (!query) {
    return { hits: [] };
  }

  const topK = Math.min(Math.max(1, input.topK ?? DEFAULT_TOP_K), RETRIEVE_CONTEXT_MAX_TOP_K);
  const embed = deps.embed ?? ((text: string) => embedText(text, EMBED_INPUT_TYPE.query));
  const queryEmbedding = await embed(query);

  const hits = await deps.retrievalIndex.search(queryEmbedding, query, {
    // accountId comes from the bound deps, NEVER from tool input — the permission boundary.
    accountId: deps.accountId,
    topK,
  });

  return { hits: hits.map(toRetrievedChunk) };
}

export function createRetrieveContextTool(deps: RetrieveContextDeps): Tool {
  return tool({
    description:
      'Retrieve prior communications and organizational knowledge relevant to the message being ' +
      'triaged, from the account-scoped knowledge layer. Use this to ground a recommendation or ' +
      'draft in real prior context (past threads, org docs, preferences) rather than guessing. ' +
      'Returns ranked chunks with their source ids and text.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Natural-language search query derived from the message being triaged.'),
      topK: z
        .number()
        .int()
        .min(1)
        .max(RETRIEVE_CONTEXT_MAX_TOP_K)
        .optional()
        .describe(`How many chunks to return (default ${DEFAULT_TOP_K}).`),
    }),
    execute: async ({ query, topK }) => runRetrieveContext(deps, { query, topK }),
  });
}

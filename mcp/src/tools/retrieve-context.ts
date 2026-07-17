import { z } from 'zod';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * `retrieveContext` MCP tool (design.md §8, README L38-L39: "Allow the Cursor agent to retrieve
 * communication context through the RAG layer"). A thin, read-only caller of the hosted
 * `mcp.retrieveContext` tRPC procedure — no local retrieval logic, no AWS credentials (brief
 * constraint 2).
 */

export const RetrieveContextInputSchema = {
  accountId: z
    .string()
    .min(1)
    .describe('The connected account to search within (permission-scoped to the caller).'),
  query: z.string().min(1).describe('Natural-language search query.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('How many chunks to return (default 5).'),
};

export interface RetrievedChunkDto {
  chunkId: string;
  sourceId: string;
  textForContext: string;
  score: number;
  channel: string;
  sourceType: string;
}

export async function runRetrieveContext(
  client: McpApiClient,
  input: { accountId: string; query: string; topK?: number },
): Promise<{ hits: RetrievedChunkDto[] }> {
  return client.query('retrieveContext', input);
}

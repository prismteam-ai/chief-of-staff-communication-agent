import { z } from 'zod';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * `recommendAction` MCP tool (design.md §8, README L39: "Allow the Cursor agent to recommend
 * actions"). Reads the agent's already-produced recommendation for `commId` off the hosted API —
 * see `apps/api/src/routers/mcp.ts`'s module doc comment for why this is a read, not a second LLM
 * call: the ingest→agent pipeline already classifies every ingested communication automatically.
 */

export const RecommendActionInputSchema = {
  commId: z.string().min(1).describe('The communication id to fetch the recommended action for.'),
};

export interface RecommendActionResult {
  commId: string;
  status: string;
  recommendation: {
    actionType: string;
    confidence: number;
    rationale: string;
  } | null;
}

export async function runRecommendAction(
  client: McpApiClient,
  input: { commId: string },
): Promise<RecommendActionResult> {
  return client.query('recommendAction', input);
}

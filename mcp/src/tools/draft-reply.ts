import { z } from 'zod';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * `draftReply` MCP tool (design.md §8, README L39: "draft responses"). Reads the agent's already-
 * produced, style-matched draft for `commId` off the hosted API (see `routers/mcp.ts`'s module doc
 * comment). To actually SEND it, the caller must separately invoke `approveDraft` — this tool never
 * sends anything itself.
 */

export const DraftReplyInputSchema = {
  commId: z.string().min(1).describe('The communication id to fetch the drafted reply for.'),
};

export interface DraftReplyResult {
  commId: string;
  status: string;
  draft: {
    body: string;
    confidence: number;
  } | null;
}

export async function runDraftReply(
  client: McpApiClient,
  input: { commId: string },
): Promise<DraftReplyResult> {
  return client.query('draftReply', input);
}

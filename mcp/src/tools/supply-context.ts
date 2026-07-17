import { z } from 'zod';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * `supplyContext` MCP tool (design.md §8, README L9/L40: "additional context"; Task 6's
 * `needs_context` recovery edge). NOT confirm-gated — supplying context is additive/non-destructive
 * (it appends text and re-queues the agent turn; it never sends anything or mutates Asana), unlike
 * `approveDraft`/`manageAsana*` which perform real external-facing writes. Mirrors
 * `ApprovalService.supplyContext`'s own scoping: only legal when the communication is in
 * `needs_context`.
 */

export const SupplyContextInputSchema = {
  commId: z.string().min(1).describe('The communication id that needs additional context.'),
  text: z.string().min(1).describe("The additional context to supply, in the user's own words."),
};

export async function runSupplyContext(
  client: McpApiClient,
  input: { commId: string; text: string },
): Promise<{ commId: string; status: string }> {
  return client.mutate('supplyContext', input);
}

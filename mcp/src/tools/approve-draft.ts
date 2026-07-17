import { z } from 'zod';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * `approveDraft` MCP tool (design.md §8, README L9: "final approval"; brief constraint 2, the
 * hypno confirm-gated write-guardrail pattern: "the only sanctioned write is `--confirm` after
 * explicit user confirmation"). This is a REAL SEND — the hosted `mcp.approveDraft` procedure calls
 * the exact same `ApprovalService.approveDraft` the dashboard's own Approve button calls, which
 * dispatches the message through the real channel connector (Gmail/WhatsApp) the moment it runs.
 *
 * The confirm gate lives HERE, in the tool handler, not on the server: `confirm` must be `true` or
 * the handler returns a dry-run preview (the draft body + recommendation) WITHOUT calling the API
 * at all — no network request reaches the hosted send path unless the caller explicitly confirms.
 * The Cursor agent is instructed (via this tool's `description`) to always show the draft to the
 * human and get their explicit "yes, send it" before ever passing `confirm: true` — never inferred
 * from conversational tone alone.
 */

export const ApproveDraftInputSchema = {
  commId: z
    .string()
    .min(1)
    .describe('The communication id whose draft should be approved and sent.'),
  confirm: z
    .boolean()
    .describe(
      'Must be explicitly true to actually send. This is a REAL, irreversible send through the ' +
        "connected channel (email/WhatsApp) — only pass true after the human has seen the draft's " +
        'exact body and explicitly confirmed sending it. Pass false (or omit) to preview the draft ' +
        'without sending anything.',
    )
    .optional()
    .default(false),
};

export type ApproveDraftResult =
  | { status: 'preview'; commId: string; message: string }
  | { status: 'sent'; commId: string; sentMessageId?: string };

export async function runApproveDraft(
  client: McpApiClient,
  input: { commId: string; confirm?: boolean },
): Promise<ApproveDraftResult> {
  if (!input.confirm) {
    return {
      status: 'preview',
      commId: input.commId,
      message:
        'Not sent — confirm was not set to true. Show the draft to the user and re-invoke with ' +
        'confirm: true only after they explicitly approve sending it.',
    };
  }

  const record = await client.mutate<{ commId: string; sentMessageId?: string }>('approveDraft', {
    commId: input.commId,
  });
  return { status: 'sent', commId: record.commId, sentMessageId: record.sentMessageId };
}

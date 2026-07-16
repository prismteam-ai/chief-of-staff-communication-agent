import { tool, type Tool } from 'ai';
import { z } from 'zod';

/**
 * `manageAsana` tool — a TYPED CONTRACT STUB (Task 5 brief: "Do not implement any real Asana API
 * call — Task 7 owns that"). The input schema and the return shape are the real contract the agent,
 * the tRPC API, and the MCP server share (design.md §5 "one list, shared by the agent, the tRPC
 * API, and the MCP server"); only the `execute` body is stubbed. Task 7 replaces the body with the
 * approval-gated Asana client and leaves this schema unchanged.
 *
 * The stub NEVER calls a real Asana endpoint and NEVER throws — it returns an unambiguous
 * `not_implemented` marker so a caller (or a test) can assert the seam is not yet wired.
 */

export const MANAGE_ASANA_ACTIONS = ['link', 'create', 'update'] as const;
export type ManageAsanaAction = (typeof MANAGE_ASANA_ACTIONS)[number];

export const ManageAsanaInputSchema = z.object({
  action: z.enum(MANAGE_ASANA_ACTIONS).describe('link, create, or update an Asana task/project.'),
  commId: z.string().min(1).describe('The communication this Asana action relates to.'),
  /** Existing Asana object gid — required for `link`/`update`, absent for `create`. */
  asanaGid: z.string().optional().describe('Target Asana gid (for link/update).'),
  /** Free-text detail (task name for create, note for update, etc.). */
  detail: z.string().optional().describe('Task name (create) or note (update/link).'),
});
export type ManageAsanaInput = z.infer<typeof ManageAsanaInputSchema>;

export interface ManageAsanaResult {
  status: 'not_implemented';
  action: ManageAsanaAction;
  commId: string;
  message: string;
}

const NOT_IMPLEMENTED_MESSAGE =
  'manageAsana is a contract stub — Task 7 wires the real, approval-gated Asana client. ' +
  'No Asana write was performed.';

/** Pure stub behavior, exposed for direct unit testing without the AI SDK envelope. */
export function runManageAsana(input: ManageAsanaInput): ManageAsanaResult {
  return {
    status: 'not_implemented',
    action: input.action,
    commId: input.commId,
    message: NOT_IMPLEMENTED_MESSAGE,
  };
}

export function createManageAsanaTool(): Tool {
  return tool({
    description:
      'Link a communication to an Asana task/project, or create/update a follow-up task. ' +
      'NOTE: not yet wired — returns a not_implemented marker until the Asana integration lands. ' +
      'Do not rely on it performing a real write.',
    inputSchema: ManageAsanaInputSchema,
    execute: async (input) => runManageAsana(input),
  });
}

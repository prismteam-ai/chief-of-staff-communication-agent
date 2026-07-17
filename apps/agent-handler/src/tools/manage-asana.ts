import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  MANAGE_ASANA_ACTIONS,
  type ManageAsanaAction,
  type SuggestedAsanaAction,
} from '@chief-of-staff/shared';

// Re-exported so callers (including this module's own tests) can import the action enum from the
// tool module directly, the same way Task 5's stub did — `@chief-of-staff/shared` remains the one
// source of truth; this is just a convenience re-export, not a second definition.
export { MANAGE_ASANA_ACTIONS };
export type { ManageAsanaAction };

/**
 * `manageAsana` tool (Task 7, design.md §9): the agent's Asana seam. Turns Task 5's typed-contract
 * stub into a REAL tool that PROPOSES an Asana action and NEVER executes one — the confirm-gated
 * write-guardrail pattern `hypno` uses for Asana writes (Task 7 brief constraint 4: "manageAsana
 * becomes real but PROPOSES not executes").
 *
 * `execute()` builds a `SuggestedAsanaAction` (`packages/shared/src/asana.ts`) and returns it; the
 * caller (`run-agent-turn.ts` today; Task 8's dashboard/MCP surface tomorrow) is responsible for
 * persisting it onto the communication record as `suggestedAsanaAction`. This function has NO
 * network dependency whatsoever — no `AsanaClient`, no `fetch`, nothing that could reach
 * `app.asana.com` — so "propose, never execute" is a structural guarantee, not just a runtime
 * choice: there is no code path here that could perform a write even by mistake.
 *
 * Turning a suggestion into a real Asana task/comment is a SEPARATE, human-approved step:
 * `createAsanaFollowup(commId, {...})` / `linkAsana(commId, taskGid)` in `apps/api`'s tRPC router,
 * which IS wired to the real `AsanaClient` and IS account-guarded (reuses
 * `ApprovalService`-style `loadAuthorized`/`assertAccountOwned`).
 */

export const ManageAsanaInputSchema = z.object({
  action: z.enum(MANAGE_ASANA_ACTIONS).describe('link, create, or update an Asana task/project.'),
  commId: z.string().min(1).describe('The communication this Asana action relates to.'),
  /** Existing Asana object gid — required for `link`/`update`, absent for `create`. */
  asanaGid: z.string().optional().describe('Target Asana gid (for link/update).'),
  /** Free-text detail (task name for create, note for update/link, etc.). */
  detail: z.string().optional().describe('Task name (create) or note (update/link).'),
  /** Optional proposed due date (`YYYY-MM-DD`) — only meaningful for create/update. */
  dueOn: z.string().optional().describe('Proposed due date YYYY-MM-DD (create/update only).'),
});
export type ManageAsanaInput = z.infer<typeof ManageAsanaInputSchema>;

export interface ManageAsanaResult {
  status: 'proposed';
  action: ManageAsanaAction;
  commId: string;
  suggestedAsanaAction: SuggestedAsanaAction;
  message: string;
}

const PROPOSED_MESSAGE =
  'manageAsana proposes an Asana action — it does NOT perform a write. The suggestion is saved on ' +
  'the communication record; a human must approve it via createAsanaFollowup/linkAsana (apps/api) ' +
  'before anything is created or changed in Asana.';

/**
 * Pure suggestion-shaping logic, exposed separately from the AI SDK `tool()` envelope so unit tests
 * (and `run-agent-turn.ts`) can call it directly. Deliberately takes ONE argument (`input`) — no
 * injected client — so the "no network dependency" guarantee in the module doc is enforceable by
 * inspection, not just convention.
 */
export function runManageAsana(input: ManageAsanaInput): ManageAsanaResult {
  const suggestedAsanaAction: SuggestedAsanaAction = {
    action: input.action,
    commId: input.commId,
    asanaGid: input.asanaGid,
    title: input.action === 'create' ? input.detail : undefined,
    note: input.action !== 'create' ? input.detail : undefined,
    dueOn: input.dueOn,
    suggestedAt: new Date().toISOString(),
  };

  return {
    status: 'proposed',
    action: input.action,
    commId: input.commId,
    suggestedAsanaAction,
    message: PROPOSED_MESSAGE,
  };
}

export function createManageAsanaTool(): Tool {
  return tool({
    description:
      'Propose linking a communication to an Asana task/project, or creating/updating a follow-up ' +
      'task. This NEVER performs the Asana write itself — it records a suggestion for human review. ' +
      'Use this whenever a communication warrants Asana follow-up tracking.',
    inputSchema: ManageAsanaInputSchema,
    execute: async (input) => runManageAsana(input),
  });
}

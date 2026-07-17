import { z } from 'zod';

/**
 * The `manageAsana` proposal contract (Task 7, design.md §9, brief constraint 4: "manageAsana
 * becomes real but PROPOSES not executes"). `SuggestedAsanaAction` is what the agent tool persists
 * onto a communication record — a structured recommendation, never a performed write. Execution is
 * a SEPARATE, human-approved step: the `createAsanaFollowup`/`linkAsana` tRPC procedures in
 * `apps/api` (the same confirm-gated pattern `hypno`'s Asana write guardrail uses).
 *
 * Lives in `packages/shared` (not `apps/agent-handler`) because both the agent tool that PRODUCES
 * this shape and the `apps/api` layer that READS/executes it need the same type — the "one list,
 * shared by the agent, the tRPC API, and the MCP server" contract design.md §5 describes for tools.
 */
export const MANAGE_ASANA_ACTIONS = ['link', 'create', 'update'] as const;
export type ManageAsanaAction = (typeof MANAGE_ASANA_ACTIONS)[number];

export const SuggestedAsanaActionSchema = z.object({
  action: z.enum(MANAGE_ASANA_ACTIONS),
  commId: z.string().min(1),
  /** Existing Asana task gid — present for `link`/`update`, absent for `create`. */
  asanaGid: z.string().optional(),
  /** Proposed task title — used for `create`. */
  title: z.string().optional(),
  /** Proposed note/comment text — used for `update`/`link`. */
  note: z.string().optional(),
  /** ISO-8601 date (`YYYY-MM-DD`) — optional proposed due date for `create`/`update`. */
  dueOn: z.string().optional(),
  /** When this suggestion was produced — lets the dashboard show staleness. */
  suggestedAt: z.string().datetime(),
});
export type SuggestedAsanaAction = z.infer<typeof SuggestedAsanaActionSchema>;

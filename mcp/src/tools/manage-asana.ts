import { z } from 'zod';
import type { McpApiClient } from '../lib/api-client.js';

/**
 * `manageAsana` MCP tool (design.md §8/§9, README L40: "update Asana"; brief constraint 2, hypno
 * confirm-gate). Same dry-run-unless-confirmed shape as `approve-draft.ts`: `confirm` must be
 * explicitly `true` or the handler returns a preview WITHOUT calling the hosted API — no Asana
 * task is created or linked unless the caller explicitly confirms. Two actions, mirroring the
 * hosted `asana` router's two procedures (`createAsanaFollowup`/`linkAsana`) — exposed as one MCP
 * tool with an `action` discriminator so Cursor sees one coherent "manage Asana" capability, same
 * as design.md §8's tool list names it.
 */

export const ManageAsanaInputSchema = {
  action: z
    .enum(['create', 'link'])
    .describe('create a new follow-up task, or link an existing one.'),
  commId: z.string().min(1).describe('The communication this Asana action relates to.'),
  title: z.string().optional().describe('Task title — required for action "create".'),
  notes: z.string().optional().describe('Optional note text (create).'),
  dueOn: z.string().optional().describe('Optional due date YYYY-MM-DD (create).'),
  taskGid: z.string().optional().describe('Existing Asana task gid — required for action "link".'),
  confirm: z
    .boolean()
    .describe(
      'Must be explicitly true to actually write to Asana. This creates or links a REAL Asana ' +
        'task — only pass true after the human has seen exactly what will be created/linked and ' +
        'explicitly confirmed. Pass false (or omit) to preview without writing anything.',
    )
    .optional()
    .default(false),
};

export type ManageAsanaResult =
  | { status: 'preview'; commId: string; message: string }
  | { status: 'done'; commId: string; asanaTaskGid?: string; asanaTaskPermalink?: string };

export interface ManageAsanaInput {
  action: 'create' | 'link';
  commId: string;
  title?: string;
  notes?: string;
  dueOn?: string;
  taskGid?: string;
  confirm?: boolean;
}

export async function runManageAsana(
  client: McpApiClient,
  input: ManageAsanaInput,
): Promise<ManageAsanaResult> {
  if (!input.confirm) {
    return {
      status: 'preview',
      commId: input.commId,
      message:
        'Not written to Asana — confirm was not set to true. Show the exact action to the user ' +
        '(create vs link, title/notes/due date or target task gid) and re-invoke with ' +
        'confirm: true only after they explicitly approve it.',
    };
  }

  if (input.action === 'create') {
    if (!input.title) {
      throw new Error('manageAsana action "create" requires a title.');
    }
    const record = await client.mutate<{
      commId: string;
      asanaTaskGid?: string;
      asanaTaskPermalink?: string;
    }>('manageAsanaCreate', {
      commId: input.commId,
      title: input.title,
      notes: input.notes,
      dueOn: input.dueOn,
    });
    return {
      status: 'done',
      commId: record.commId,
      asanaTaskGid: record.asanaTaskGid,
      asanaTaskPermalink: record.asanaTaskPermalink,
    };
  }

  if (!input.taskGid) {
    throw new Error('manageAsana action "link" requires a taskGid.');
  }
  const record = await client.mutate<{
    commId: string;
    asanaTaskGid?: string;
    asanaTaskPermalink?: string;
  }>('manageAsanaLink', { commId: input.commId, taskGid: input.taskGid });
  return {
    status: 'done',
    commId: record.commId,
    asanaTaskGid: record.asanaTaskGid,
    asanaTaskPermalink: record.asanaTaskPermalink,
  };
}

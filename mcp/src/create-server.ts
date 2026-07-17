import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpApiClient, type ApiClientConfig } from './lib/api-client.js';
import { RetrieveContextInputSchema, runRetrieveContext } from './tools/retrieve-context.js';
import { RecommendActionInputSchema, runRecommendAction } from './tools/recommend-action.js';
import { DraftReplyInputSchema, runDraftReply } from './tools/draft-reply.js';
import { ApproveDraftInputSchema, runApproveDraft } from './tools/approve-draft.js';
import { SupplyContextInputSchema, runSupplyContext } from './tools/supply-context.js';
import { ManageAsanaInputSchema, runManageAsana } from './tools/manage-asana.js';

/**
 * Builds the pidgeot MCP server (Task 11, design.md §8): registers the 4-tool contract
 * (`retrieveContext`/`recommendAction`/`draftReply`/`manageAsana`) PLUS the approval surface
 * (`approveDraft`/`supplyContext`) README L9 names as the Cursor workflow's stated purpose. Every
 * tool calls the hosted tRPC API over HTTPS with the per-user token — no AWS credentials, no direct
 * DynamoDB/OpenSearch access (brief constraint 2). Extracted from `server.ts` (the stdio entry
 * point) so tests can build a server against an injectable `fetchImpl` without touching stdin/stdout
 * or `process.env`.
 */

export interface CreateServerOptions {
  apiUrl: string;
  apiToken: string;
  fetchImpl?: ApiClientConfig['fetchImpl'];
}

export function createPidgeotMcpServer(options: CreateServerOptions): McpServer {
  const client = createMcpApiClient({
    baseUrl: options.apiUrl,
    token: options.apiToken,
    fetchImpl: options.fetchImpl,
  });

  const server = new McpServer({
    name: 'pidgeot',
    version: '0.1.0',
  });

  server.registerTool(
    'retrieveContext',
    {
      title: 'Retrieve communication context',
      description:
        'Retrieve prior communications and organizational knowledge relevant to a topic, from the ' +
        "account-scoped RAG knowledge layer. Read-only. Scoped to the caller's own token — never " +
        'accepts a userId.',
      inputSchema: RetrieveContextInputSchema,
    },
    async (input) => {
      const result = await runRetrieveContext(client, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'recommendAction',
    {
      title: 'Get the recommended action for a communication',
      description:
        'Fetch the recommended action (action type, confidence, rationale) the agent already ' +
        'produced for a communication. Read-only — does not run a new classification.',
      inputSchema: RecommendActionInputSchema,
    },
    async (input) => {
      const result = await runRecommendAction(client, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'draftReply',
    {
      title: 'Get the drafted reply for a communication',
      description:
        'Fetch the style-matched reply draft the agent already produced for a communication. ' +
        'Read-only — to actually SEND it, call approveDraft with confirm: true after the user ' +
        'explicitly approves.',
      inputSchema: DraftReplyInputSchema,
    },
    async (input) => {
      const result = await runDraftReply(client, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'approveDraft',
    {
      title: 'Approve and send a drafted reply (WRITE, confirm-gated)',
      description:
        'Approves and SENDS a drafted reply through the real connected channel (email/WhatsApp). ' +
        'This is a real, user-facing send — ALWAYS show the exact draft body to the user and get ' +
        'their explicit approval before calling this with confirm: true. Calling with confirm: ' +
        'false (or omitting it) only previews the draft and sends nothing.',
      inputSchema: ApproveDraftInputSchema,
    },
    async (input) => {
      const result = await runApproveDraft(client, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'supplyContext',
    {
      title: 'Supply additional context for a communication',
      description:
        'Supplies additional context for a communication the agent could not confidently handle, ' +
        'and re-queues it for another pass. Non-destructive — safe to call once the user has ' +
        'provided the missing information.',
      inputSchema: SupplyContextInputSchema,
    },
    async (input) => {
      const result = await runSupplyContext(client, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'manageAsana',
    {
      title: 'Create or link an Asana follow-up task (WRITE, confirm-gated)',
      description:
        'Creates a new Asana follow-up task, or links a communication to an existing Asana task. ' +
        'This is a real Asana write — ALWAYS show the user exactly what will be created/linked ' +
        '(title/notes/due date, or the target task) and get their explicit approval before calling ' +
        'this with confirm: true. Calling with confirm: false (or omitting it) only previews the ' +
        'action and writes nothing to Asana.',
      inputSchema: ManageAsanaInputSchema,
    },
    async (input) => {
      const result = await runManageAsana(client, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}

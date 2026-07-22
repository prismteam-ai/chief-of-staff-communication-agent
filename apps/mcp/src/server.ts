import {
  mcpToolNameSchema,
  mcpToolSchemas,
  type McpToolName,
} from '@chief/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import type { McpRequestScope, McpToolService } from './service.js';
import { McpToolError, McpToolRuntime } from './service.js';

const descriptions: Readonly<Record<McpToolName, string>> = Object.freeze({
  list_pending_communications:
    'List a bounded page of server-scoped communications.',
  get_communication:
    'Get one server-authorized communication revision with citations.',
  get_thread_context:
    'Get a bounded page of one authorized communication thread.',
  search_knowledge:
    'Search bounded cited knowledge under the server-derived fixture scope.',
  get_related_asana_work:
    'Retrieve bounded read-only Asana context related to a communication.',
  recommend_action:
    'Prepare a cited action recommendation without executing an effect.',
  create_draft: 'Prepare a cited immutable draft revision without sending it.',
  revise_draft: 'Prepare a new immutable cited draft revision.',
  request_context: 'Prepare a focused context request for missing facts.',
  prepare_asana_action:
    'Prepare an immutable Asana proposal and HTTPS approval handoff.',
  submit_for_approval:
    'Legacy compatibility tool; unavailable in the durable fixed-scope MCP runtime. Use the HTTPS product draft-approval flow. No effect is executed.',
  get_approval_status: 'Read the status of an immutable proposal.',
  get_connector_status:
    'Read truthful connector modes, health, and capabilities.',
  get_sla_metrics: 'Read a bounded SLA metrics snapshot.',
});

function toolAnnotations(toolName: McpToolName) {
  const readOnly = [
    'list_pending_communications',
    'get_communication',
    'get_thread_context',
    'search_knowledge',
    'get_related_asana_work',
    'get_approval_status',
    'get_connector_status',
    'get_sla_metrics',
  ].includes(toolName);
  return {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function safeToolError(error: unknown): string {
  return error instanceof McpToolError ? error.safeMessage : 'TOOL_FAILED';
}

export function createMcpServer(options: {
  readonly service: McpToolService;
  readonly scope: McpRequestScope;
  readonly timeoutMs?: number;
}): McpServer {
  const server = new McpServer(
    { name: 'chief-of-staff-communication-agent', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Read and prepare only. Human approval in the HTTPS product is required for every provider or Asana effect.',
    },
  );
  const runtime = new McpToolRuntime(
    options.service,
    options.scope,
    options.timeoutMs,
  );

  for (const toolName of mcpToolNameSchema.options) {
    const schemas = mcpToolSchemas[toolName];
    const inputSchema = schemas.input as z.ZodType<
      Readonly<Record<string, unknown>>
    >;
    const outputSchema = schemas.result as z.ZodType<Record<string, unknown>>;
    server.registerTool(
      toolName,
      {
        title: toolName,
        description: descriptions[toolName],
        inputSchema,
        outputSchema,
        annotations: toolAnnotations(toolName),
      },
      async (input): Promise<CallToolResult> => {
        try {
          const result = await runtime.execute(toolName, input);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: safeToolError(error) }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

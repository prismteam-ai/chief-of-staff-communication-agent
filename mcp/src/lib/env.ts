/**
 * Runtime environment contract for the MCP server (Task 11, design.md §8). Set in the operator's
 * `~/.cursor/mcp.json` `env` block (see `skills/use-pidgeot/reference/mcp-setup.md`) — never in
 * source, never logged. Same "non-secret config knob or a token, never a literal in code" discipline
 * `apps/api/src/env.ts` uses.
 */
export interface McpServerEnv {
  /** The deployed API's base URL, e.g. `https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com`. */
  readonly apiUrl: string;
  /** The per-user token minted by the dashboard's `issueMcpToken` (Task 8's token-issuance view). */
  readonly apiToken: string;
}

export class McpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerConfigError';
  }
}

export function loadMcpServerEnv(source: NodeJS.ProcessEnv = process.env): McpServerEnv {
  const apiUrl = source.COS_API_URL?.trim();
  const apiToken = source.COS_API_TOKEN?.trim();

  if (!apiUrl) {
    throw new McpServerConfigError(
      'COS_API_URL is not set — add it to the "env" block in ~/.cursor/mcp.json (the deployed ' +
        'API base URL, e.g. https://klxrwe0sa3.execute-api.us-east-2.amazonaws.com).',
    );
  }
  if (!apiToken) {
    throw new McpServerConfigError(
      'COS_API_TOKEN is not set — mint one from the dashboard\'s "MCP tokens" view and add it to ' +
        'the "env" block in ~/.cursor/mcp.json.',
    );
  }

  return { apiUrl, apiToken };
}

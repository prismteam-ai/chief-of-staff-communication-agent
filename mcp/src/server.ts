#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPidgeotMcpServer } from './create-server.js';
import { loadMcpServerEnv, McpServerConfigError } from './lib/env.js';

/**
 * stdio entry point (Task 11, design.md §8: "an MCP server (stdio, npx-runnable)"). This is the
 * file Cursor's `mcp.json` launches — see the repo-root `mcp.json` / `skills/use-pidgeot/` for the
 * exact block an operator pastes into `~/.cursor/mcp.json`. Reads `COS_API_URL`/`COS_API_TOKEN`
 * from the environment (set in `mcp.json`'s `env` block, never hardcoded) and fails fast with a
 * clear stderr message — never a silent hang — if either is missing, since stdio MCP clients only
 * see whatever this process writes to stderr in their logs.
 */

async function main(): Promise<void> {
  let env;
  try {
    env = loadMcpServerEnv();
  } catch (error) {
    if (error instanceof McpServerConfigError) {
      console.error(`[pidgeot-mcp] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const server = createPidgeotMcpServer({ apiUrl: env.apiUrl, apiToken: env.apiToken });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[pidgeot-mcp] connected over stdio');
}

main().catch((error: unknown) => {
  console.error('[pidgeot-mcp] fatal error', error);
  process.exit(1);
});

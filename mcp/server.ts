/**
 * MCP stdio entrypoint for local clients (Cursor, Claude Desktop).
 * Run: npx tsx --env-file=.env mcp/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools";

async function main() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("[chief-of-comms] MCP server ready (stdio)");
}

main().catch((err) => {
  console.error("[chief-of-comms] fatal:", err);
  process.exit(1);
});

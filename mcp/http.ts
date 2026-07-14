/**
 * MCP Streamable HTTP entrypoint — hosted remotely (Azure Container Apps).
 *
 * Stateless mode: every POST /mcp is a self-contained request, which keeps
 * the server horizontally simple and avoids session affinity requirements.
 * Auth: Bearer token compared against MCP_AUTH_TOKEN (required in prod).
 *
 * Run: npx tsx --env-file=.env mcp/http.ts
 */
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./tools";

const PORT = Number(process.env.PORT ?? 3001);
const TOKEN = process.env.MCP_AUTH_TOKEN;

const httpServer = createHttpServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "unauthorized" })
    );
    return;
  }
  if (req.method !== "POST") {
    // Stateless mode: no SSE stream or session termination endpoints.
    res.writeHead(405).end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400).end();
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => transport.close());
    await createServer().connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[mcp-http] request failed:", err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

if (!TOKEN) {
  console.warn("[mcp-http] WARNING: MCP_AUTH_TOKEN not set — endpoint is unauthenticated");
}

httpServer.listen(PORT, () => {
  console.log(`[chief-of-comms] MCP server ready (http) on :${PORT}/mcp`);
});

/**
 * MCP Streamable HTTP entrypoint — hosted remotely (Azure Container Apps).
 *
 * Stateless mode: every POST /mcp is a self-contained request.
 * Auth: per-user Bearer tokens (User.mcpToken, managed on the app's
 * /mcp-setup page). Each token scopes all tools to that user's data.
 * MCP_AUTH_TOKEN (+ MCP_USER_EMAIL) is kept as a legacy fallback.
 *
 * Run: npx tsx --env-file=.env mcp/http.ts
 */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { prisma } from "../src/lib/prisma";
import { createServer, envUserResolver, type UserResolver } from "./tools";

const PORT = Number(process.env.PORT ?? 3001);
const LEGACY_TOKEN = process.env.MCP_AUTH_TOKEN;

async function resolveUser(req: IncomingMessage): Promise<UserResolver | null> {
  const header = req.headers.authorization;
  let token: string | null = null;
  if (header?.startsWith("Bearer ")) {
    token = header.slice(7).trim() || null;
  } else if (req.url) {
    // Token-in-URL (/mcp/<token>) for clients that can't send custom
    // headers and don't do OAuth, e.g. Claude web custom connectors.
    const path = new URL(req.url, "http://localhost").pathname;
    const m = path.match(/^\/mcp\/([^/]+)$/);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) return null;
  const user = await prisma.user.findUnique({ where: { mcpToken: token }, select: { id: true } });
  if (user) return async () => user.id;
  if (LEGACY_TOKEN && token === LEGACY_TOKEN) return envUserResolver;
  return null;
}

const httpServer = createHttpServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  const resolver = await resolveUser(req).catch(() => null);
  if (!resolver) {
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
    await createServer(resolver).connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[mcp-http] request failed:", err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, () => {
  console.log(`[chief-of-comms] MCP server ready (http) on :${PORT}/mcp`);
});

/**
 * Chief of Communications — MCP tool definitions shared by the stdio
 * (mcp/server.ts) and HTTP (mcp/http.ts) entrypoints.
 *
 * Exposes the agent layer as tools: dashboard stats, unanswered messages,
 * pending approvals, approve/reject, run agents, live Asana status reports,
 * and RAG knowledge search.
 *
 * The user is selected via MCP_USER_EMAIL (defaults to the first user).
 * See docs/cursor-mcp.md for the Cursor configuration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prisma } from "../src/lib/prisma";
import { runAgents, dispatchAction } from "../src/lib/agent-runtime";
import { updateResponseStatuses } from "../src/lib/agent-runtime/tracking";
import { statusReport } from "../src/lib/agent-runtime/skills";
import { retrieve } from "../src/lib/rag/retrieve";
import { indexUserKnowledge } from "../src/lib/rag/indexer";

export type UserResolver = () => Promise<string>;

/** Default resolver for stdio: MCP_USER_EMAIL env (or first user). */
export async function envUserResolver(): Promise<string> {
  const email = process.env.MCP_USER_EMAIL;
  const user = email
    ? await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })
    : await prisma.user.findFirst();
  if (!user) throw new Error(`No user found${email ? ` for ${email}` : ""}`);
  return user.id;
}

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function createServer(getUserId: UserResolver = envUserResolver): McpServer {
  const server = new McpServer({ name: "chief-of-comms", version: "1.0.0" });

server.tool(
  "get_dashboard_stats",
  "Communication metrics: volume, answered/pending/overdue (5-min SLA), channel breakdown, response times, pending approvals.",
  { days: z.number().min(1).max(90).default(7).describe("Lookback window in days") },
  async ({ days }) => {
    const userId = await getUserId();
    await updateResponseStatuses(userId);
    const since = new Date(Date.now() - days * 86_400_000);
    const slaCutoff = new Date(Date.now() - 5 * 60_000);
    const inbound = await prisma.message.findMany({
      where: { userId, isOutbound: false, sentAt: { gte: since } },
      select: { provider: true, responseStatus: true, sentAt: true, answeredAt: true },
    });
    const byChannel: Record<string, number> = {};
    let pending = 0, answered = 0, notNeeded = 0, overdue = 0;
    const mins: number[] = [];
    for (const m of inbound) {
      byChannel[m.provider] = (byChannel[m.provider] ?? 0) + 1;
      if (m.responseStatus === "answered") {
        answered++;
        if (m.answeredAt) mins.push((m.answeredAt.getTime() - m.sentAt.getTime()) / 60_000);
      } else if (m.responseStatus === "not_needed") notNeeded++;
      else {
        pending++;
        if (m.sentAt < slaCutoff) overdue++;
      }
    }
    mins.sort((a, b) => a - b);
    const pendingApprovals = await prisma.agentAction.count({
      where: { userId, status: "pending_approval" },
    });
    return text({
      days,
      total: inbound.length,
      answered,
      pending,
      notNeeded,
      overdueOver5Min: overdue,
      pendingApprovals,
      byChannel,
      medianResponseMinutes: mins.length ? Math.round(mins[Math.floor(mins.length / 2)]) : null,
      answeredWithin5Min: mins.filter((v) => v <= 5).length,
    });
  }
);

server.tool(
  "list_unanswered",
  "Inbound communications still awaiting a response, oldest first.",
  { limit: z.number().min(1).max(50).default(20) },
  async ({ limit }) => {
    const userId = await getUserId();
    await updateResponseStatuses(userId);
    const messages = await prisma.message.findMany({
      where: { userId, isOutbound: false, responseStatus: "pending" },
      orderBy: { sentAt: "asc" },
      take: limit,
      select: {
        id: true,
        provider: true,
        subject: true,
        snippet: true,
        sentAt: true,
        participants: { where: { role: "from" }, select: { name: true, address: true } },
      },
    });
    return text(
      messages.map((m) => ({
        messageId: m.id,
        channel: m.provider,
        from: m.participants[0]?.address,
        subject: m.subject,
        snippet: m.snippet,
        receivedAt: m.sentAt,
        waitingMinutes: Math.round((Date.now() - m.sentAt.getTime()) / 60_000),
      }))
    );
  }
);

server.tool(
  "list_pending_approvals",
  "Drafted agent actions waiting for human approval (replies, Asana task proposals, needs-context prompts).",
  {},
  async () => {
    const userId = await getUserId();
    const actions = await prisma.agentAction.findMany({
      where: { userId, status: "pending_approval" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        type: true,
        channel: true,
        recipient: true,
        subject: true,
        body: true,
        recommendation: true,
        meta: true,
        createdAt: true,
        agent: { select: { name: true } },
        message: { select: { subject: true, snippet: true } },
      },
    });
    return text(actions);
  }
);

server.tool(
  "approve_action",
  "Approve a pending action and execute it (sends the reply and/or creates the Asana task). Optionally override the reply body.",
  {
    actionId: z.string().describe("The pending action id"),
    body: z.string().optional().describe("Edited reply body (replaces the draft)"),
  },
  async ({ actionId, body }) => {
    const userId = await getUserId();
    const action = await prisma.agentAction.findFirst({ where: { id: actionId, userId } });
    if (!action) return text("Action not found");
    if (action.status !== "pending_approval") return text(`Action is ${action.status}`);
    if (body?.trim()) {
      await prisma.agentAction.update({ where: { id: actionId }, data: { body: body.trim() } });
    } else if (action.type === "needs_context" && !action.body) {
      return text("This action needs a reply body — pass `body` or use provide_context first.");
    }
    const ok = await dispatchAction(actionId);
    const updated = await prisma.agentAction.findUnique({
      where: { id: actionId },
      select: { status: true, statusNote: true, sentAt: true },
    });
    return text({ dispatched: ok, ...updated });
  }
);

server.tool(
  "reject_action",
  "Reject/dismiss a pending agent action.",
  { actionId: z.string() },
  async ({ actionId }) => {
    const userId = await getUserId();
    const action = await prisma.agentAction.findFirst({ where: { id: actionId, userId } });
    if (!action) return text("Action not found");
    await prisma.agentAction.update({
      where: { id: actionId },
      data: { status: "rejected", resolvedAt: new Date() },
    });
    return text("Rejected.");
  }
);

server.tool(
  "run_agents_now",
  "Sync is handled by the app scheduler; this immediately runs the agent runtime over recent inbound messages and reports what was drafted/sent/blocked.",
  {},
  async () => {
    const userId = await getUserId();
    const summary = await runAgents(userId);
    return text(summary);
  }
);

server.tool(
  "asana_status",
  "Live Asana status report. Mention a project name to focus on it; otherwise summarizes all projects.",
  { query: z.string().default("all projects").describe("e.g. 'Website Redesign' or 'all projects'") },
  async ({ query }) => {
    const userId = await getUserId();
    return text(await statusReport(userId, query, true));
  }
);

server.tool(
  "search_knowledge",
  "RAG search across communication history, Asana context, user preferences, and organizational knowledge.",
  {
    query: z.string().describe("Natural-language query"),
    k: z.number().min(1).max(20).default(6),
  },
  async ({ query, k }) => {
    const userId = await getUserId();
    const results = await retrieve(userId, query, { k });
    return text(
      results.map((r) => ({
        source: r.source,
        title: r.title,
        score: Number(r.score.toFixed(3)),
        content: r.content.slice(0, 500),
      }))
    );
  }
);

server.tool(
  "reindex_knowledge",
  "Rebuild the RAG knowledge index from messages, Asana, preferences, and org knowledge.",
  {},
  async () => {
    const userId = await getUserId();
    return text(await indexUserKnowledge(userId));
  }
);

  return server;
}

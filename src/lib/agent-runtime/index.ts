import { Prisma, type Agent, type AgentAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkPolicy } from "./policy";
import { generateDraft } from "./draft";
import { runSkills, executeCreateTask, type AsanaTaskProposal } from "./skills";
import { retrieve, formatContext } from "@/lib/rag/retrieve";
import { senders } from "@/lib/send";

const LOOKBACK_HOURS = 72;

export interface RunSummary {
  scanned: number;
  drafted: number;
  sentOnAutopilot: number;
  blocked: number;
  failed: number;
}

/**
 * The core agent runtime: scan recent inbound messages, and for every active
 * agent whose channels cover the message, apply the agent's policy and
 * produce a recommended action:
 *  - blocked contact / newsletter → no_action (message marked not_needed)
 *  - unclear question the agent can't confidently answer → needs_context
 *  - otherwise → drafted reply (and/or Asana task proposal), which is
 *    auto-sent when the agent mode is autopilot;
 *    everything else waits for approval.
 */
export async function runAgents(userId: string): Promise<RunSummary> {
  const summary: RunSummary = {
    scanned: 0,
    drafted: 0,
    sentOnAutopilot: 0,
    blocked: 0,
    failed: 0,
  };

  const agents = await prisma.agent.findMany({
    where: { userId, isActive: true },
  });
  if (agents.length === 0) return summary;

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000);
  const messages = await prisma.message.findMany({
    where: { userId, isOutbound: false, sentAt: { gte: since } },
    orderBy: { sentAt: "desc" },
    take: 200,
    include: { participants: { where: { role: "from" } } },
  });
  summary.scanned = messages.length;

  for (const message of messages) {
    const sender = message.participants[0];
    if (!sender) continue;

    for (const agent of agents) {
      if (!agent.channels.includes(message.provider)) continue;

      const existing = await prisma.agentAction.findUnique({
        where: { agentId_messageId: { agentId: agent.id, messageId: message.id } },
        select: { id: true },
      });
      if (existing) continue;

      const decision = checkPolicy(agent, message.provider, sender.address);
      if (!decision.allowed) {
        await createAction(agent, message.id, {
          channel: message.provider,
          recipient: sender.address,
          subject: replySubject(message.subject),
          body: "",
          status: "blocked",
          statusNote: decision.reason,
          type: "no_action",
          recommendation: "No reply needed — sender is outside this agent's contact policy.",
        });
        await prisma.message.updateMany({
          where: { id: message.id, responseStatus: "pending" },
          data: { responseStatus: "not_needed" },
        });
        summary.blocked++;
        continue;
      }

      let body: string;
      let actionType = "reply";
      let recommendation = "Reply with the suggested draft.";
      let meta: Prisma.InputJsonValue | undefined;
      let skillMatched = false;
      try {
        const messageText = stripQuoted(message.body ?? message.snippet ?? "");
        const history = await loadThreadHistory(message.threadId, message.id);
        let skillContext: string | null = null;

        // Skills: ground the reply in live Asana data / propose Asana tasks
        let skill: Awaited<ReturnType<typeof runSkills>> = { kind: "none" };
        try {
          skill = await runSkills(agent, `${message.subject ?? ""}\n${messageText}`, {
            threadContext: history?.inboundText,
          });
        } catch {
          // Asana unavailable — fall back to a plain reply
        }
        if (skill.kind === "status_context") {
          skillContext = skill.context;
          skillMatched = true;
          recommendation = skill.projectName
            ? `Reply with a live status report for Asana project "${skill.projectName}".`
            : "Reply with a live status summary across Asana projects.";
        } else if (skill.kind === "create_task") {
          skillContext = skill.context;
          skillMatched = true;
          actionType = "create_task";
          recommendation = `Create Asana task "${skill.proposal.taskName}"${skill.proposal.projectName ? ` in "${skill.proposal.projectName}"` : ""} and confirm to the sender.`;
          meta = { proposal: { ...skill.proposal } };
        }

        // RAG: retrieve knowledge from history, Asana, preferences, org notes
        let knowledgeContext: string | null = null;
        let ragChunks: Awaited<ReturnType<typeof retrieve>> = [];
        try {
          ragChunks = await retrieve(agent.userId, `${message.subject ?? ""} ${messageText}`.trim(), {
            k: 5,
            excludeSourceIds: [message.id],
          });
          knowledgeContext = formatContext(ragChunks);
        } catch {
          // retrieval failure should never block a reply
        }

        // Confidence gate: a question or request we have no grounded answer
        // for (and no LLM configured) → ask the user for context instead of
        // sending a generic acknowledgement (especially bad on autopilot).
        const hasLlm = Boolean(
          process.env.AZURE_OPENAI_ENDPOINT &&
            process.env.AZURE_OPENAI_API_KEY &&
            process.env.AZURE_OPENAI_DEPLOYMENT
        );
        const looksLikeRequest =
          /\?|\b(please|can you|could you|would you|give me|send me|let me know|need|what|when|where|why|how|who)\b/i.test(
            messageText
          );
        if (!skillMatched && !hasLlm && looksLikeRequest) {
          const suggestions = ragChunks.slice(0, 3).map((c) => ({
            source: c.source,
            title: c.title,
            content: c.content.slice(0, 300),
          }));
          const action = await createAction(agent, message.id, {
            channel: message.provider,
            recipient: sender.address,
            subject: replySubject(message.subject),
            body: "",
            status: "pending_approval",
            statusNote: "The agent can't confidently answer this question — add context or write the reply.",
            type: "needs_context",
            recommendation:
              "Needs your input: the sender asked a question the agent has no data to answer." +
              (suggestions.length ? " Possibly relevant knowledge attached." : ""),
            meta: suggestions.length ? { ragSuggestions: suggestions } : undefined,
          });
          if (action) summary.drafted++;
          continue;
        }

        body = await generateDraft(agent, {
          channel: message.provider,
          senderName: sender.name,
          senderAddress: sender.address,
          subject: message.subject,
          body: messageText,
          skillContext,
          history: history?.transcript ?? null,
          knowledgeContext,
        });
      } catch (err) {
        await createAction(agent, message.id, {
          channel: message.provider,
          recipient: sender.address,
          subject: replySubject(message.subject),
          body: "",
          status: "failed",
          statusNote: err instanceof Error ? err.message : "Draft generation failed",
        });
        summary.failed++;
        continue;
      }

      // Autopilot agents act autonomously; HITL agents queue for approval.
      const autoSend = agent.mode === "autopilot";
      const action = await createAction(agent, message.id, {
        channel: message.provider,
        recipient: sender.address,
        subject: replySubject(message.subject),
        body,
        status: autoSend ? "approved" : "pending_approval",
        type: actionType,
        recommendation,
        meta,
      });
      if (!action) continue;
      summary.drafted++;

      if (autoSend) {
        const ok = await dispatchAction(action.id);
        if (ok) summary.sentOnAutopilot++;
        else summary.failed++;
      }
    }
  }

  return summary;
}

function replySubject(subject?: string | null): string | null {
  if (!subject) return null;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Remove quoted reply chains ("On ... wrote:", "> " lines, Outlook separators). */
export function stripQuoted(text: string): string {
  let out = text;
  const markers = [
    /\r?\nOn .{5,120}wrote:\s*[\s\S]*$/,
    /\r?\n-{3,}\s*Original Message\s*-{3,}[\s\S]*$/i,
    /\r?\nFrom:\s.+\r?\nSent:\s[\s\S]*$/,
    /\r?\n_{10,}[\s\S]*$/,
  ];
  for (const re of markers) out = out.replace(re, "");
  out = out
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(">"))
    .join("\n");
  return out.trim();
}

interface ThreadHistory {
  /** Readable transcript of the conversation so far (oldest first). */
  transcript: string;
  /** Only what the other party said — used for intent carry-over. */
  inboundText: string;
}

/** Load prior messages in the thread (excluding the one being replied to). */
async function loadThreadHistory(
  threadId: string | null,
  excludeMessageId: string
): Promise<ThreadHistory | null> {
  if (!threadId) return null;
  const prior = await prisma.message.findMany({
    where: { threadId, id: { not: excludeMessageId } },
    orderBy: { sentAt: "desc" },
    take: 6,
    select: { isOutbound: true, body: true, snippet: true },
  });
  if (!prior.length) return null;

  const oldestFirst = prior.reverse();
  const transcript = oldestFirst
    .map((m) => {
      const text = stripQuoted(m.body ?? m.snippet ?? "").slice(0, 600);
      return `${m.isOutbound ? "You (agent)" : "Them"}: ${text}`;
    })
    .join("\n---\n");
  const inboundText = oldestFirst
    .filter((m) => !m.isOutbound)
    .map((m) => stripQuoted(m.body ?? m.snippet ?? ""))
    .join("\n");
  return { transcript, inboundText };
}

async function createAction(
  agent: Agent,
  messageId: string,
  data: {
    channel: string;
    recipient: string;
    subject: string | null;
    body: string;
    status: string;
    statusNote?: string | null;
    type?: string;
    recommendation?: string | null;
    meta?: Prisma.InputJsonValue;
  }
): Promise<AgentAction | null> {
  const { type, ...rest } = data;
  try {
    return await prisma.agentAction.create({
      data: {
        userId: agent.userId,
        agentId: agent.id,
        messageId,
        type: type ?? "reply",
        ...rest,
        resolvedAt: ["blocked", "failed"].includes(data.status) ? new Date() : null,
      },
    });
  } catch (err) {
    // unique(agentId, messageId) race — another run already handled it
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return null;
    }
    throw err;
  }
}

/**
 * Send an approved action through the real channel. Re-checks policy at send
 * time (config may have changed since drafting).
 */
export async function dispatchAction(actionId: string): Promise<boolean> {
  const action = await prisma.agentAction.findUnique({
    where: { id: actionId },
    include: { agent: true, message: { select: { externalId: true } } },
  });
  if (!action || action.status === "sent") return false;

  const decision = checkPolicy(action.agent, action.channel, action.recipient);
  if (!decision.allowed) {
    await prisma.agentAction.update({
      where: { id: action.id },
      data: { status: "blocked", statusNote: decision.reason, resolvedAt: new Date() },
    });
    return false;
  }

  const sender = senders[action.channel];
  if (!sender) {
    await prisma.agentAction.update({
      where: { id: action.id },
      data: {
        status: "failed",
        statusNote: `Channel "${action.channel}" does not support sending`,
        resolvedAt: new Date(),
      },
    });
    return false;
  }

  try {
    // Skill side effect first: create the Asana task, then confirm to sender
    let statusNote: string | null = null;
    if (action.type === "create_task") {
      const meta = action.meta as { proposal?: AsanaTaskProposal } | null;
      if (!meta?.proposal) throw new Error("Missing Asana task proposal on action");
      const gid = await executeCreateTask(action.userId, meta.proposal);
      statusNote = `Asana task created (${
        meta.proposal.projectName ? `project "${meta.proposal.projectName}"` : "workspace"
      }, gid ${gid})`;
    }

    await sender({
      userId: action.userId,
      recipient: action.recipient,
      subject: action.subject,
      body: action.body,
      inReplyToExternalId: action.message?.externalId ?? null,
    });
    await prisma.agentAction.update({
      where: { id: action.id },
      data: { status: "sent", statusNote, sentAt: new Date(), resolvedAt: new Date() },
    });
    if (action.messageId) {
      await prisma.message.updateMany({
        where: { id: action.messageId, responseStatus: "pending" },
        data: { responseStatus: "answered", answeredAt: new Date() },
      });
    }
    return true;
  } catch (err) {
    await prisma.agentAction.update({
      where: { id: action.id },
      data: {
        status: "failed",
        statusNote: err instanceof Error ? err.message : "Send failed",
        resolvedAt: new Date(),
      },
    });
    return false;
  }
}

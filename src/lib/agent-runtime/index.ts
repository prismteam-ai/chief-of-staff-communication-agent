import { Prisma, type Agent, type AgentAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkPolicy } from "./policy";
import { generateDraft } from "./draft";
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
 * agent with auto-reply enabled whose channels cover the message, apply the
 * agent's policy and produce an action:
 *  - hitl  → pending_approval (approvals queue)
 *  - autopilot → send immediately
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
    where: { userId, isActive: true, autoReply: true },
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
        });
        summary.blocked++;
        continue;
      }

      let body: string;
      try {
        body = await generateDraft(agent, {
          channel: message.provider,
          senderName: sender.name,
          senderAddress: sender.address,
          subject: message.subject,
          body: message.body ?? message.snippet ?? "",
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

      const action = await createAction(agent, message.id, {
        channel: message.provider,
        recipient: sender.address,
        subject: replySubject(message.subject),
        body,
        status: agent.mode === "autopilot" ? "approved" : "pending_approval",
      });
      if (!action) continue;
      summary.drafted++;

      if (agent.mode === "autopilot") {
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
  }
): Promise<AgentAction | null> {
  try {
    return await prisma.agentAction.create({
      data: {
        userId: agent.userId,
        agentId: agent.id,
        messageId,
        type: "reply",
        ...data,
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
    await sender({
      userId: action.userId,
      recipient: action.recipient,
      subject: action.subject,
      body: action.body,
      inReplyToExternalId: action.message?.externalId ?? null,
    });
    await prisma.agentAction.update({
      where: { id: action.id },
      data: { status: "sent", statusNote: null, sentAt: new Date(), resolvedAt: new Date() },
    });
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

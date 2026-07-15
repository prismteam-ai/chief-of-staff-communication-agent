import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const SLA_MINUTES = 5;

/**
 * GET /api/dashboard?days=7 — communication metrics:
 * volume, response status, overdue (>5 min unanswered), channel breakdown,
 * response-time stats, pending approvals, and recommended actions.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const days = Math.min(Number(req.nextUrl.searchParams.get("days")) || 7, 90);
  const since = new Date(Date.now() - days * 86_400_000);
  const slaCutoff = new Date(Date.now() - SLA_MINUTES * 60_000);

  const inbound = await prisma.message.findMany({
    where: { userId, isOutbound: false, sentAt: { gte: since } },
    select: { provider: true, responseStatus: true, sentAt: true, answeredAt: true },
  });

  const byChannel: Record<string, { total: number; pending: number; answered: number; notNeeded: number }> = {};
  let pending = 0;
  let answered = 0;
  let notNeeded = 0;
  let overdue = 0;
  const responseMinutes: number[] = [];

  for (const m of inbound) {
    const ch = (byChannel[m.provider] ??= { total: 0, pending: 0, answered: 0, notNeeded: 0 });
    ch.total++;
    if (m.responseStatus === "answered") {
      answered++;
      ch.answered++;
      if (m.answeredAt) {
        responseMinutes.push((m.answeredAt.getTime() - m.sentAt.getTime()) / 60_000);
      }
    } else if (m.responseStatus === "not_needed") {
      notNeeded++;
      ch.notNeeded++;
    } else {
      pending++;
      ch.pending++;
      if (m.sentAt < slaCutoff) overdue++;
    }
  }

  responseMinutes.sort((a, b) => a - b);
  const avg = responseMinutes.length
    ? responseMinutes.reduce((s, v) => s + v, 0) / responseMinutes.length
    : null;
  const median = responseMinutes.length
    ? responseMinutes[Math.floor(responseMinutes.length / 2)]
    : null;
  const withinSla = responseMinutes.filter((v) => v <= SLA_MINUTES).length;

  const [pendingApprovals, recommendations] = await Promise.all([
    prisma.agentAction.count({ where: { userId, status: "pending_approval" } }),
    prisma.agentAction.findMany({
      where: { userId, recommendation: { not: null }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        type: true,
        status: true,
        channel: true,
        recipient: true,
        recommendation: true,
        createdAt: true,
        agent: { select: { name: true } },
        message: {
          select: {
            subject: true,
            snippet: true,
            sentAt: true,
            responseStatus: true,
            participants: { where: { role: "from" }, select: { name: true, address: true } },
          },
        },
      },
    }),
  ]);

  return NextResponse.json({
    days,
    slaMinutes: SLA_MINUTES,
    volume: { total: inbound.length, pending, answered, notNeeded, overdue },
    byChannel,
    responseTime: {
      avgMinutes: avg,
      medianMinutes: median,
      answeredCount: responseMinutes.length,
      withinSla,
      slaRate: responseMinutes.length ? withinSla / responseMinutes.length : null,
    },
    pendingApprovals,
    recommendations,
  });
}

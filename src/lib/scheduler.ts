import { prisma } from "@/lib/prisma";
import { ingestors } from "@/lib/ingest";
import { syncConnection } from "@/lib/sync";
import { runAgents } from "@/lib/agent-runtime";

const DEFAULT_INTERVAL_SECONDS = 60;

/**
 * Background scheduler: every interval, for each user who has an active
 * auto-reply agent, sync all their syncable channels and run the agent
 * runtime. This is what makes autopilot pick up new messages without any
 * manual "Sync" / "Run agents" clicks.
 *
 * Started once per server process from src/instrumentation.ts. A module-level
 * flag on globalThis guards against double-starts in dev (HMR reloads).
 */

declare global {
  // eslint-disable-next-line no-var
  var __agentSchedulerStarted: boolean | undefined;
}

export function startScheduler() {
  if (globalThis.__agentSchedulerStarted) return;
  globalThis.__agentSchedulerStarted = true;

  const seconds = Number(process.env.AGENT_POLL_INTERVAL_SECONDS) || DEFAULT_INTERVAL_SECONDS;
  console.log(`[scheduler] agent autopilot polling every ${seconds}s`);

  let running = false;
  const tick = async () => {
    if (running) return; // skip overlapping ticks
    running = true;
    try {
      await runOnce();
    } catch (err) {
      console.error("[scheduler] tick failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, seconds * 1000);
  // first pass shortly after boot
  setTimeout(tick, 5_000);
}

async function runOnce() {
  // only users with at least one agent that can act autonomously
  const agents = await prisma.agent.findMany({
    where: { isActive: true, autoReply: true },
    select: { userId: true },
    distinct: ["userId"],
  });

  for (const { userId } of agents) {
    const connections = await prisma.channelConnection.findMany({
      where: { userId, status: { not: "disconnected" } },
      select: { provider: true },
    });

    for (const { provider } of connections) {
      if (!ingestors[provider]) continue; // e.g. asana, linkedin
      try {
        const res = await syncConnection(userId, provider);
        if (res.inserted > 0) {
          console.log(`[scheduler] ${provider}: ${res.inserted} new message(s) for ${userId}`);
        }
      } catch (err) {
        console.error(
          `[scheduler] sync ${provider} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    try {
      const summary = await runAgents(userId);
      if (summary.drafted > 0 || summary.sentOnAutopilot > 0) {
        console.log(
          `[scheduler] agents for ${userId}: ${summary.drafted} drafted, ${summary.sentOnAutopilot} sent on autopilot`
        );
      }
    } catch (err) {
      console.error("[scheduler] runAgents failed:", err instanceof Error ? err.message : err);
    }
  }
}

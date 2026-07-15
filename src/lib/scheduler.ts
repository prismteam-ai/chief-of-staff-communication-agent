import { prisma } from "@/lib/prisma";
import { ingestors } from "@/lib/ingest";
import { syncConnection } from "@/lib/sync";
import { runAgents } from "@/lib/agent-runtime";
import { updateResponseStatuses } from "@/lib/agent-runtime/tracking";
import { indexUserKnowledge } from "@/lib/rag/indexer";

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

const INDEX_INTERVAL_MS = 5 * 60_000;
const lastIndexed = new Map<string, number>();

async function runOnce() {
  // only users with at least one active agent
  const agents = await prisma.agent.findMany({
    where: { isActive: true },
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
      await updateResponseStatuses(userId);
      // refresh the RAG knowledge index every few minutes
      if (Date.now() - (lastIndexed.get(userId) ?? 0) > INDEX_INTERVAL_MS) {
        lastIndexed.set(userId, Date.now());
        const idx = await indexUserKnowledge(userId);
        if (idx.written > 0) {
          console.log(`[scheduler] knowledge index: ${idx.written} chunk(s) updated for ${userId}`);
        }
      }
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

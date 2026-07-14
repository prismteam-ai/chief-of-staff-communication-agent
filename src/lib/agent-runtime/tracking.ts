import { prisma } from "@/lib/prisma";

/**
 * Response tracking: mark inbound messages as answered when a later outbound
 * message exists in the same thread (whether sent by an agent or the user
 * themselves from their mail client). Runs on every scheduler tick.
 */
export async function updateResponseStatuses(userId: string): Promise<number> {
  const pending = await prisma.message.findMany({
    where: { userId, isOutbound: false, responseStatus: "pending", threadId: { not: null } },
    select: { id: true, threadId: true, sentAt: true },
    take: 500,
  });
  if (!pending.length) return 0;

  let updated = 0;
  for (const msg of pending) {
    const reply = await prisma.message.findFirst({
      where: {
        userId,
        threadId: msg.threadId,
        isOutbound: true,
        sentAt: { gt: msg.sentAt },
      },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    });
    if (reply) {
      await prisma.message.update({
        where: { id: msg.id },
        data: { responseStatus: "answered", answeredAt: reply.sentAt },
      });
      updated++;
    }
  }
  return updated;
}

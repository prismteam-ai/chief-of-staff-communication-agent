import { prisma } from "@/lib/prisma";
import type { NormalizedMessage } from "./types";

/** Upsert normalized messages (with threads, participants, attachments). */
export async function persistMessages(
  userId: string,
  provider: string,
  messages: NormalizedMessage[]
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const msg of messages) {
    const exists = await prisma.message.findUnique({
      where: {
        userId_provider_externalId: { userId, provider, externalId: msg.externalId },
      },
      select: { id: true },
    });
    if (exists) {
      skipped++;
      continue;
    }

    let threadId: string | undefined;
    if (msg.threadExternalId) {
      const thread = await prisma.thread.upsert({
        where: {
          userId_provider_externalId: {
            userId,
            provider,
            externalId: msg.threadExternalId,
          },
        },
        create: {
          userId,
          provider,
          externalId: msg.threadExternalId,
          subject: msg.threadSubject ?? msg.subject ?? null,
          lastMessageAt: msg.sentAt,
        },
        update: {},
      });
      threadId = thread.id;
      if (!thread.lastMessageAt || thread.lastMessageAt < msg.sentAt) {
        await prisma.thread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: msg.sentAt,
            ...(msg.threadSubject ? { subject: msg.threadSubject } : {}),
          },
        });
      }
    }

    await prisma.message.create({
      data: {
        userId,
        provider,
        externalId: msg.externalId,
        threadId,
        subject: msg.subject ?? null,
        snippet: msg.snippet?.slice(0, 500) ?? null,
        body: msg.body ?? null,
        sentAt: msg.sentAt,
        isOutbound: msg.isOutbound,
        participants: {
          create: msg.participants
            .filter((p) => p.address)
            .map((p) => ({ role: p.role, name: p.name ?? null, address: p.address })),
        },
        attachments: {
          create: msg.attachments.map((a) => ({
            externalId: a.externalId ?? null,
            filename: a.filename,
            mimeType: a.mimeType ?? null,
            sizeBytes: a.sizeBytes ?? null,
          })),
        },
      },
    });
    inserted++;
  }

  return { inserted, skipped };
}

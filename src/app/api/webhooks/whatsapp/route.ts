import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { persistMessages, type NormalizedMessage } from "@/lib/ingest";

/**
 * Meta WhatsApp Business Cloud API webhook.
 * Configure in Meta App Dashboard → WhatsApp → Configuration:
 *   Callback URL: {APP_BASE_URL}/api/webhooks/whatsapp
 *   Verify token: WHATSAPP_WEBHOOK_VERIFY_TOKEN
 */

/** GET — Meta webhook verification handshake. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
  ) {
    return new NextResponse(params.get("hub.challenge") ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

interface WaMessage {
  id: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
}

/** POST — inbound message events. */
export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => null);
  if (!payload?.entry) return NextResponse.json({ ok: true });

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== "messages" || !value?.messages) continue;

      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const userId = await findUserByPhoneNumberId(phoneNumberId);
      if (!userId) continue;

      const contacts = new Map<string, string>(
        (value.contacts ?? []).map((c: { wa_id: string; profile?: { name?: string } }) => [
          c.wa_id,
          c.profile?.name ?? "",
        ])
      );

      const messages: NormalizedMessage[] = (value.messages as WaMessage[]).map((m) => {
        const media = m.image ?? m.document ?? m.audio ?? m.video;
        const body =
          m.text?.body ??
          m.image?.caption ??
          m.document?.caption ??
          m.video?.caption ??
          (m.type ? `[${m.type}]` : null);
        return {
          externalId: m.id,
          threadExternalId: m.from ?? null,
          threadSubject: m.from ? contacts.get(m.from) || m.from : null,
          subject: null,
          snippet: body?.slice(0, 200) ?? null,
          body,
          sentAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          isOutbound: false,
          participants: m.from
            ? [{ role: "from" as const, name: contacts.get(m.from) || null, address: m.from }]
            : [],
          attachments: media?.id
            ? [
                {
                  externalId: media.id,
                  filename:
                    (m.document?.filename as string | undefined) ?? `${m.type}-${media.id}`,
                  mimeType: media.mime_type ?? null,
                  sizeBytes: null,
                },
              ]
            : [],
        };
      });

      await persistMessages(userId, "whatsapp", messages);
    }
  }

  return NextResponse.json({ ok: true });
}

/** Match the webhook's phone_number_id to a connected user's WhatsApp credentials. */
async function findUserByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const connections = await prisma.channelConnection.findMany({
    where: { provider: "whatsapp", credentials: { not: null } },
    select: { userId: true, credentials: true },
  });
  for (const conn of connections) {
    try {
      const creds = JSON.parse(await decrypt(conn.credentials!));
      if (creds.phoneNumberId === phoneNumberId) return conn.userId;
    } catch {
      // skip undecryptable rows
    }
  }
  return null;
}

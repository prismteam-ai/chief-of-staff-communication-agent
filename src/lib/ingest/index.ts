import type { Ingestor } from "./types";
import { ingestGmail } from "./gmail";
import { ingestOutlook } from "./outlook";
import { ingestSms } from "./sms";
import { ingestX } from "./x";

/**
 * Ingestors by provider.
 * - whatsapp: no history API — inbound messages arrive via webhook
 *   (/api/webhooks/whatsapp)
 * - linkedin: member-to-member messaging has no public read API
 */
export const ingestors: Record<string, Ingestor | undefined> = {
  gmail: ingestGmail,
  outlook: ingestOutlook,
  sms: ingestSms,
  x: ingestX,
};

export const INGEST_UNSUPPORTED: Record<string, string> = {
  whatsapp:
    "WhatsApp has no history API — new inbound messages are ingested in real time via the webhook once configured in Meta.",
  linkedin:
    "LinkedIn does not expose a public API for reading member messages.",
};

export * from "./types";
export { persistMessages } from "./persist";

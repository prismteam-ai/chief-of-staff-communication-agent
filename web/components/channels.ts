export const CHANNELS: Record<
  string,
  { label: string; color: string; glyph: string }
> = {
  gmail: { label: "Gmail", color: "var(--color-gmail)", glyph: "✉" },
  x: { label: "X", color: "var(--color-x)", glyph: "𝕏" },
  whatsapp: { label: "WhatsApp", color: "var(--color-whatsapp)", glyph: "◉" },
  asana: { label: "Asana", color: "var(--color-asana)", glyph: "◆" },
};

export function channelMeta(c: string) {
  return CHANNELS[c] ?? { label: c, color: "var(--color-muted)", glyph: "•" };
}

export const PRIORITY_COLOR: Record<string, string> = {
  urgent: "var(--color-bad)",
  high: "var(--color-warn)",
  medium: "var(--color-accent)",
  low: "var(--color-muted)",
};

// Actions that produce a draft the exec can approve + send.
export const DRAFT_ACTIONS = new Set([
  "REPLY",
  "ASK_SENDER",
  "DECLINE",
  "ACKNOWLEDGE",
  "FOLLOW_UP",
  "INTRODUCE",
]);

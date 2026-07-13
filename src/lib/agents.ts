import { providers } from "@/lib/providers";

export const COMMUNICATION_STYLES = [
  "professional",
  "formal",
  "casual",
  "friendly",
  "direct",
  "empathetic",
];
export const TONES = ["neutral", "warm", "concise", "playful", "assertive", "authoritative"];
export const MODES = ["autopilot", "hitl"];
export const CONTACT_POLICIES = ["all", "allowlist", "blocklist"];
export const SKILLS = ["asana_status_report", "asana_create_task"];

export interface AgentInput {
  name?: unknown;
  description?: unknown;
  communicationStyle?: unknown;
  toneOfVoice?: unknown;
  customInstructions?: unknown;
  autoReply?: unknown;
  mode?: unknown;
  channels?: unknown;
  contactPolicy?: unknown;
  contactList?: unknown;
  skills?: unknown;
  isActive?: unknown;
}

export function validateAgent(body: AgentInput, partial = false) {
  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) errors.push("Name is required");
    else out.name = body.name.trim();
  }
  if (body.description !== undefined)
    out.description = typeof body.description === "string" ? body.description.trim() || null : null;
  if (!partial || body.communicationStyle !== undefined) {
    const v = body.communicationStyle ?? "professional";
    if (!COMMUNICATION_STYLES.includes(v as string)) errors.push("Invalid communication style");
    else out.communicationStyle = v;
  }
  if (!partial || body.toneOfVoice !== undefined) {
    const v = body.toneOfVoice ?? "neutral";
    if (!TONES.includes(v as string)) errors.push("Invalid tone of voice");
    else out.toneOfVoice = v;
  }
  if (body.customInstructions !== undefined)
    out.customInstructions =
      typeof body.customInstructions === "string"
        ? body.customInstructions.trim() || null
        : null;
  if (body.autoReply !== undefined) out.autoReply = Boolean(body.autoReply);
  if (!partial || body.mode !== undefined) {
    const v = body.mode ?? "hitl";
    if (!MODES.includes(v as string)) errors.push("Invalid mode");
    else out.mode = v;
  }
  if (!partial || body.channels !== undefined) {
    const list = Array.isArray(body.channels) ? body.channels : [];
    const valid = Object.keys(providers);
    const bad = list.filter((c) => !valid.includes(c as string));
    if (bad.length) errors.push(`Unknown channels: ${bad.join(", ")}`);
    else out.channels = list;
  }
  if (!partial || body.contactPolicy !== undefined) {
    const v = body.contactPolicy ?? "all";
    if (!CONTACT_POLICIES.includes(v as string)) errors.push("Invalid contact policy");
    else out.contactPolicy = v;
  }
  if (!partial || body.contactList !== undefined) {
    const list = Array.isArray(body.contactList) ? body.contactList : [];
    out.contactList = list
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.trim())
      .filter(Boolean);
  }
  if (!partial || body.skills !== undefined) {
    const list = Array.isArray(body.skills) ? body.skills : [];
    const bad = list.filter((s) => !SKILLS.includes(s as string));
    if (bad.length) errors.push(`Unknown skills: ${bad.join(", ")}`);
    else out.skills = list;
  }
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);

  return { errors, data: out };
}

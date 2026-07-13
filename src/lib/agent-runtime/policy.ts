import type { Agent } from "@prisma/client";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Can this agent use this channel? */
export function checkChannel(agent: Agent, channel: string): PolicyDecision {
  if (!agent.isActive) return { allowed: false, reason: "Agent is paused" };
  if (!agent.channels.includes(channel)) {
    return { allowed: false, reason: `Channel "${channel}" is not enabled for this agent` };
  }
  return { allowed: true };
}

/** Can this agent communicate with this recipient, per its contact rules? */
export function checkContact(agent: Agent, recipient: string): PolicyDecision {
  const target = normalize(recipient);
  const list = agent.contactList.map(normalize);

  switch (agent.contactPolicy) {
    case "allowlist":
      return list.includes(target)
        ? { allowed: true }
        : { allowed: false, reason: `${recipient} is not on this agent's allowlist` };
    case "blocklist":
      return list.includes(target)
        ? { allowed: false, reason: `${recipient} is on this agent's blocklist` }
        : { allowed: true };
    default:
      return { allowed: true };
  }
}

/** Full gate: channel + contact. */
export function checkPolicy(agent: Agent, channel: string, recipient: string): PolicyDecision {
  const ch = checkChannel(agent, channel);
  if (!ch.allowed) return ch;
  return checkContact(agent, recipient);
}

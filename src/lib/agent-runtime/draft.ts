import type { Agent } from "@prisma/client";

export interface DraftInput {
  channel: string;
  senderName?: string | null;
  senderAddress: string;
  subject?: string | null;
  body: string;
  /** Live data pulled by an agent skill (e.g., Asana project status). */
  skillContext?: string | null;
  /** Prior conversation in this thread, oldest first. */
  history?: string | null;
}

/** Build the system prompt from the agent's configured characteristics. */
export function buildSystemPrompt(agent: Agent): string {
  const lines = [
    `You are "${agent.name}", an AI communications agent replying on behalf of your principal.`,
    agent.description ? `Your responsibility: ${agent.description}` : null,
    `Communication style: ${agent.communicationStyle}.`,
    `Tone of voice: ${agent.toneOfVoice}.`,
    agent.customInstructions ? `Additional instructions: ${agent.customInstructions}` : null,
    "Reply concisely and appropriately for the channel. Output only the reply body — no subject line, no explanations.",
  ];
  return lines.filter(Boolean).join("\n");
}

function channelHint(channel: string): string {
  switch (channel) {
    case "sms":
    case "whatsapp":
      return "This is a chat message — keep the reply short (1-3 sentences), no greetings/signatures.";
    case "x":
      return "This is a public X reply — max 280 characters.";
    default:
      return "This is an email — a short professional reply with an appropriate greeting and sign-off.";
  }
}

/**
 * Generate a reply draft.
 * Uses Azure OpenAI when configured (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY,
 * AZURE_OPENAI_DEPLOYMENT); otherwise falls back to a deterministic template so
 * the pipeline works end-to-end without an LLM key.
 */
export async function generateDraft(agent: Agent, input: DraftInput): Promise<string> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (endpoint && apiKey && deployment) {
    const res = await fetch(
      `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=2024-06-01`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        body: JSON.stringify({
          messages: [
            { role: "system", content: `${buildSystemPrompt(agent)}\n${channelHint(input.channel)}` },
            {
              role: "user",
              content:
                `Incoming ${input.channel} message from ${input.senderName ?? input.senderAddress} (${input.senderAddress})` +
                (input.subject ? `\nSubject: ${input.subject}` : "") +
                (input.history
                  ? `\n\nConversation so far in this thread:\n${input.history}\n\nTheir latest message:`
                  : "") +
                `\n\n${input.body}` +
                (input.skillContext
                  ? `\n\nLive data pulled from Asana (ground your reply in these facts, do not invent numbers):\n${input.skillContext}`
                  : "") +
                `\n\nWrite the reply.`,
            },
          ],
          max_tokens: 500,
          temperature: 0.4,
        }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
    // fall through to template on API failure
  }

  return templateDraft(agent, input);
}

function templateDraft(agent: Agent, input: DraftInput): string {
  const name = input.senderName?.split(" ")[0] ?? "there";
  const casual = ["casual", "friendly"].includes(agent.communicationStyle);
  const greeting = casual ? `Hi ${name},` : `Hello ${name},`;
  const ack = input.history
    ? "Thanks for the follow-up."
    : input.subject
      ? `Thank you for your message regarding "${input.subject}".`
      : "Thank you for reaching out.";

  if (input.skillContext) {
    const facts = input.skillContext;
    if (input.channel === "sms" || input.channel === "whatsapp" || input.channel === "x") {
      return `${ack} Here's the latest:\n${facts}\n— ${agent.name}`;
    }
    return `${greeting}\n\n${ack} Here is the latest:\n\n${facts}\n\nLet me know if you'd like more detail.\n\nBest regards,\n${agent.name}`;
  }

  if (input.channel === "sms" || input.channel === "whatsapp") {
    return `${ack} We've received your message and will get back to you shortly. — ${agent.name}`;
  }
  if (input.channel === "x") {
    return `${ack} We'll follow up with you shortly.`;
  }
  return `${greeting}\n\n${ack} We have received it and will respond as soon as possible.\n\nBest regards,\n${agent.name}`;
}

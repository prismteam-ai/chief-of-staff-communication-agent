"use client";

import type { AgentEvent } from "@/lib/types";

const KIND: Record<string, { label: string; color: string; glyph: string }> = {
  thought: { label: "Thought", color: "var(--color-accent-2)", glyph: "◇" },
  tool_call: { label: "Tool", color: "var(--color-x)", glyph: "⚙" },
  action: { label: "Action", color: "var(--color-good)", glyph: "➤" },
  draft: { label: "Draft", color: "var(--color-accent)", glyph: "✎" },
  context: { label: "Context", color: "var(--color-muted)", glyph: "⧉" },
  error: { label: "Error", color: "var(--color-bad)", glyph: "⚠" },
};

function line(ev: AgentEvent): { title: string; detail?: string } {
  switch (ev.type) {
    case "thought":
      return { title: `${ev.step}: ${ev.text}` };
    case "tool_call":
      return {
        title: ev.name,
        detail:
          typeof ev.result === "string"
            ? ev.result
            : ev.result
            ? JSON.stringify(ev.result)
            : undefined,
      };
    case "action":
      return {
        title: `${ev.recommendation.action}${
          ev.recommendation.asana_op !== "NONE"
            ? ` + ${ev.recommendation.asana_op}`
            : ""
        }`,
        detail: ev.recommendation.rationale,
      };
    case "draft":
      return { title: ev.text };
    case "context":
      return {
        title: "retrieved context",
        detail: `${ev.context.facts.length} facts · ${ev.context.related_tasks.length} tasks · ${ev.context.cross_channel.length} cross-channel`,
      };
    case "error":
      return { title: ev.message };
    default:
      return { title: "" };
  }
}

export default function AgentTrace({
  events,
  running,
}: {
  events: AgentEvent[];
  running: boolean;
}) {
  const shown = events.filter((e) => e.type !== "result");
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">
          Agent reasoning
        </span>
        {running && (
          <span className="flex gap-0.5 items-center text-xs text-[var(--color-accent)]">
            <span className="thinking-dot">●</span>
            <span className="thinking-dot" style={{ animationDelay: "0.2s" }}>
              ●
            </span>
            <span className="thinking-dot" style={{ animationDelay: "0.4s" }}>
              ●
            </span>
            <span className="ml-1">thinking</span>
          </span>
        )}
      </div>
      <ol className="space-y-1.5">
        {shown.map((ev, i) => {
          const meta = KIND[ev.type] ?? KIND.thought;
          const { title, detail } = line(ev);
          return (
            <li key={i} className="flex gap-2 text-sm">
              <span
                className="shrink-0 mt-0.5"
                style={{ color: meta.color }}
                title={meta.label}
              >
                {meta.glyph}
              </span>
              <span className="min-w-0">
                <span className="break-words">{title}</span>
                {detail && (
                  <span className="block text-xs text-[var(--color-muted)] break-words">
                    {detail}
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {!shown.length && (
          <li className="text-sm text-[var(--color-muted)]">
            Select a message to run the agent.
          </li>
        )}
      </ol>
    </div>
  );
}

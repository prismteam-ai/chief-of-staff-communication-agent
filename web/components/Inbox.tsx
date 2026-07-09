"use client";

import { useEffect, useMemo, useState } from "react";
import type { InboxMessage } from "@/lib/types";
import { channelMeta } from "./channels";

export default function Inbox({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (m: InboxMessage) => void;
}) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/messages")
      .then((r) => r.json())
      .then((d) => setMessages(d.messages ?? []))
      .finally(() => setLoading(false));
  }, []);

  const channels = useMemo(
    () => ["all", ...Array.from(new Set(messages.map((m) => m.channel)))],
    [messages]
  );
  const shown = messages.filter((m) => filter === "all" || m.channel === filter);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2.5 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">
            Inbox
          </span>
          <span className="chip">{shown.length}</span>
        </div>
        <div className="flex gap-1 mt-2 flex-wrap">
          {channels.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className="chip"
              style={
                filter === c
                  ? { borderColor: "var(--color-accent)", color: "var(--color-text)" }
                  : undefined
              }
            >
              {c === "all" ? "All" : channelMeta(c).label}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll flex-1">
        {loading && (
          <div className="p-4 text-sm text-[var(--color-muted)]">Loading…</div>
        )}
        {shown.map((m) => {
          const meta = channelMeta(m.channel);
          const active = m.id === selectedId;
          return (
            <button
              key={m.id}
              onClick={() => onSelect(m)}
              className={`w-full text-left px-3 py-2.5 border-b border-[var(--color-border)] hover:bg-[var(--color-panel-2)] ${
                active ? "bg-[var(--color-panel-2)]" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: meta.color }}
                />
                <span className="text-sm font-medium truncate">
                  {m.sender.name}
                </span>
                <span className="ml-auto flex gap-1 shrink-0">
                  {m.awaiting && (
                    <span
                      className="chip"
                      style={{ color: "var(--color-warn)" }}
                    >
                      awaiting
                    </span>
                  )}
                </span>
              </div>
              <div className="text-xs text-[var(--color-muted)] truncate mt-0.5">
                {m.subject ? `${m.subject} · ` : ""}
                {m.snippet}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

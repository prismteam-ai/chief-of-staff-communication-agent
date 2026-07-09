"use client";

import { useEffect, useState } from "react";
import type { Metrics } from "@/lib/types";
import { channelMeta } from "./channels";

function fmtTime(s: number | null): string {
  if (s == null) return "—";
  if (s < 90) return `${Math.round(s)}s`;
  return `${Math.round(s / 60)}m`;
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-bold leading-none" style={{ color }}>
        {value}
      </span>
      <span className="text-[0.65rem] uppercase tracking-wide text-[var(--color-muted)] mt-1">
        {label}
      </span>
    </div>
  );
}

export default function MetricsBar({ refreshKey }: { refreshKey: number }) {
  const [m, setM] = useState<Metrics | null>(null);

  useEffect(() => {
    fetch("/api/metrics")
      .then((r) => (r.ok ? r.json() : null))
      .then(setM)
      .catch(() => {});
  }, [refreshKey]);

  if (!m) return null;

  const channels = Object.entries(m.by_channel);

  return (
    <div className="flex items-center gap-6 px-4 py-2.5 border-b border-[var(--color-border)] overflow-x-auto shrink-0">
      <Stat label="messages" value={m.total} color="var(--color-accent)" />
      <Stat label="awaiting" value={m.awaiting} color="var(--color-warn)" />
      <Stat label="overdue" value={m.overdue} color="var(--color-bad)" />
      <Stat label="answered" value={m.answered} color="var(--color-good)" />
      <Stat label="pending approval" value={m.pending_approvals} />
      <Stat
        label="median response"
        value={fmtTime(m.median_response_seconds)}
        color="var(--color-good)"
      />
      <div className="h-8 w-px bg-[var(--color-border)]" />
      <div className="flex items-center gap-4">
        {channels.map(([ch, n]) => {
          const meta = channelMeta(ch as never);
          return (
            <div key={ch} className="flex items-center gap-1.5">
              <span style={{ color: meta.color }}>{meta.glyph}</span>
              <span className="text-sm font-semibold">{n}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

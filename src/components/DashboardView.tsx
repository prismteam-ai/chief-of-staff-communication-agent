"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  reply: { label: "Reply", cls: "bg-sky-900/60 text-sky-300" },
  create_task: { label: "Asana task", cls: "bg-violet-900/60 text-violet-300" },
  needs_context: { label: "Needs you", cls: "bg-amber-900/60 text-amber-300" },
  no_action: { label: "No action", cls: "bg-neutral-800 text-neutral-400" },
};

interface Stats {
  days: number;
  slaMinutes: number;
  volume: { total: number; pending: number; answered: number; notNeeded: number; overdue: number };
  byChannel: Record<string, { total: number; pending: number; answered: number; notNeeded: number }>;
  responseTime: {
    avgMinutes: number | null;
    medianMinutes: number | null;
    answeredCount: number;
    withinSla: number;
    slaRate: number | null;
  };
  pendingApprovals: number;
  recommendations: {
    id: string;
    type: string;
    status: string;
    channel: string;
    recipient: string;
    recommendation: string;
    createdAt: string;
    agent: { name: string };
    message: {
      subject: string | null;
      snippet: string | null;
      sentAt: string;
      responseStatus: string;
      participants: { name: string | null; address: string }[];
    } | null;
  }[];
}

function fmtMinutes(v: number | null): string {
  if (v === null) return "—";
  if (v < 1) return "<1 min";
  if (v < 60) return `${Math.round(v)} min`;
  if (v < 60 * 24) return `${(v / 60).toFixed(1)} h`;
  return `${(v / (60 * 24)).toFixed(1)} d`;
}

export default function DashboardView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    try {
      const res = await fetch(`/api/dashboard?days=${d}`);
      if (res.ok) setStats(await res.json());
      else setError("Failed to load dashboard");
    } catch {
      // transient — keep last stats
    }
  }, []);

  useEffect(() => {
    load(days);
    const t = setInterval(() => load(days), 30_000);
    return () => clearInterval(t);
  }, [days, load]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!stats) return <p className="text-sm text-neutral-500">Loading…</p>;

  const { volume, responseTime, byChannel } = stats;
  const slaPct = responseTime.slaRate === null ? null : Math.round(responseTime.slaRate * 100);

  const cards = [
    { label: `Inbound (${stats.days}d)`, value: volume.total, sub: "communications" },
    {
      label: "Awaiting response",
      value: volume.pending,
      sub: `${volume.overdue} overdue (>${stats.slaMinutes} min)`,
      warn: volume.overdue > 0,
    },
    { label: "Answered", value: volume.answered, sub: `${volume.notNeeded} needed no reply` },
    {
      label: "Pending approvals",
      value: stats.pendingApprovals,
      sub: "drafts waiting for you",
      href: "/actions",
    },
    {
      label: `Answered <${stats.slaMinutes} min`,
      value: slaPct === null ? "—" : `${slaPct}%`,
      sub: `${responseTime.withinSla}/${responseTime.answeredCount} within goal`,
      warn: slaPct !== null && slaPct < 80,
    },
    {
      label: "Response time",
      value: fmtMinutes(responseTime.medianMinutes),
      sub: `avg ${fmtMinutes(responseTime.avgMinutes)}`,
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Dashboard</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Goal: every communication answered in under {stats.slaMinutes} minutes.
          </p>
        </div>
        <div className="flex gap-2">
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                days === d
                  ? "bg-white text-neutral-900"
                  : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {d === 1 ? "24h" : `${d}d`}
            </button>
          ))}
        </div>
      </div>

      {/* Metric cards */}
      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => {
          const inner = (
            <div
              className={`rounded-xl border p-4 transition ${
                c.warn
                  ? "border-amber-800 bg-amber-950/30"
                  : "border-neutral-800 bg-neutral-900"
              } ${c.href ? "hover:border-neutral-600" : ""}`}
            >
              <p className="text-xs text-neutral-400">{c.label}</p>
              <p className="mt-1 text-2xl font-semibold">{c.value}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{c.sub}</p>
            </div>
          );
          return c.href ? (
            <Link key={c.label} href={c.href}>
              {inner}
            </Link>
          ) : (
            <div key={c.label}>{inner}</div>
          );
        })}
      </div>

      {/* Channel breakdown */}
      <h3 className="mt-8 text-sm font-semibold uppercase text-neutral-500">
        Channel breakdown
      </h3>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(byChannel).length === 0 ? (
          <p className="text-sm text-neutral-500">No inbound communications in this window.</p>
        ) : (
          Object.entries(byChannel).map(([ch, s]) => {
            const answeredPct = s.total ? Math.round((s.answered / s.total) * 100) : 0;
            return (
              <div key={ch} className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium capitalize">
                    {ch}
                  </p>
                  <p className="text-xs text-neutral-500">{s.total} msgs</p>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="h-full bg-emerald-600"
                    style={{ width: `${answeredPct}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  {s.answered} answered · {s.pending} waiting · {s.notNeeded} no reply needed
                </p>
              </div>
            );
          })
        )}
      </div>

      {/* Recommended actions */}
      <div className="mt-8 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase text-neutral-500">
          Recommended actions
        </h3>
        <Link href="/actions" className="text-xs text-neutral-400 underline hover:text-white">
          Open actions queue →
        </Link>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {stats.recommendations.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No recommendations yet — they appear as messages arrive.
          </p>
        ) : (
          stats.recommendations.map((r) => {
            const from = r.message?.participants[0];
            const badge = TYPE_BADGE[r.type] ?? TYPE_BADGE.reply;
            return (
              <div
                key={r.id}
                className="flex items-start justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-neutral-200">
                                        <span className="text-neutral-400">
                      {from?.name ?? from?.address ?? r.recipient}
                    </span>
                    {r.message?.subject ? ` — ${r.message.subject}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-400">{r.recommendation}</p>
                  <p className="mt-0.5 text-xs text-neutral-600">
                    {r.agent.name} · {new Date(r.createdAt).toLocaleString()} ·{" "}
                    {r.message?.responseStatus === "answered"
                      ? "answered"
                      : r.message?.responseStatus === "not_needed"
                        ? "◻︎ no reply needed"
                        : "⏳ awaiting response"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs ${badge.cls}`}>
                    {badge.label}
                  </span>
                  <span className="text-xs capitalize text-neutral-500">
                    {r.status.replace("_", " ")}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

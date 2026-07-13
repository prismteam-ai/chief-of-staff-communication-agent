"use client";

import { useCallback, useEffect, useState } from "react";

const CHANNEL_ICON: Record<string, string> = {
  gmail: "✉️",
  outlook: "📧",
  linkedin: "💼",
  x: "𝕏",
  whatsapp: "💬",
  sms: "📱",
};

const STATUS_STYLES: Record<string, string> = {
  pending_approval: "bg-amber-900/60 text-amber-300",
  sent: "bg-emerald-900/60 text-emerald-300",
  rejected: "bg-neutral-800 text-neutral-400",
  blocked: "bg-red-900/60 text-red-300",
  failed: "bg-red-900/60 text-red-300",
  approved: "bg-sky-900/60 text-sky-300",
};

interface ActionDto {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  statusNote: string | null;
  createdAt: string;
  sentAt: string | null;
  agent: { name: string; mode: string };
  message: {
    subject: string | null;
    snippet: string | null;
    sentAt: string;
    provider: string;
    participants: { name: string | null; address: string }[];
  } | null;
}

const FILTERS = [
  { id: "pending_approval", label: "Pending" },
  { id: "sent", label: "Sent" },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed" },
  { id: "rejected", label: "Rejected" },
  { id: "", label: "All" },
];

export default function ApprovalsView() {
  const [filter, setFilter] = useState("pending_approval");
  const [actions, setActions] = useState<ActionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = useCallback(async (status: string) => {
    const res = await fetch(`/api/actions${status ? `?status=${status}` : ""}`);
    if (res.ok) setActions((await res.json()).actions);
    setLoading(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    load(filter);
  }, [filter, load]);

  const runAgents = async () => {
    setRunning(true);
    setBanner(null);
    const res = await fetch("/api/agents/run", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBanner(
      res.ok
        ? `Scanned ${data.scanned} messages · ${data.drafted} drafts · ${data.sentOnAutopilot} sent on autopilot · ${data.blocked} blocked · ${data.failed} failed`
        : data.error ?? "Agent run failed"
    );
    await load(filter);
    setRunning(false);
  };

  const resolve = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    const res = await fetch(`/api/actions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, ...(edits[id] ? { body: edits[id] } : {}) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBanner(data.action?.statusNote ?? data.error ?? `${decision} failed`);
    }
    await load(filter);
    setBusy(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Agent actions</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Review what your agents drafted. Approving sends the message through the
            real channel.
          </p>
        </div>
        <button
          onClick={runAgents}
          disabled={running}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          {running ? "Running…" : "▶ Run agents now"}
        </button>
      </div>

      {banner && (
        <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs text-neutral-300">
          {banner}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1 text-xs transition ${
              filter === f.id
                ? "bg-white text-neutral-900"
                : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {loading ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : actions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-700 p-10 text-center text-sm text-neutral-500">
            Nothing here. Sync your inbox, then hit “Run agents now”.
          </div>
        ) : (
          actions.map((a) => {
            const from = a.message?.participants[0];
            const pending = a.status === "pending_approval";
            return (
              <div key={a.id} className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs text-neutral-400">
                    <p>
                      <span className="font-medium text-neutral-200">🤖 {a.agent.name}</span>{" "}
                      wants to reply via {CHANNEL_ICON[a.channel] ?? ""} {a.channel} to{" "}
                      <span className="text-neutral-200">{a.recipient}</span>
                    </p>
                    <p className="mt-0.5">
                      {new Date(a.createdAt).toLocaleString()}
                      {a.sentAt && ` · sent ${new Date(a.sentAt).toLocaleString()}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs capitalize ${STATUS_STYLES[a.status] ?? "bg-neutral-800 text-neutral-400"}`}
                  >
                    {a.status.replace("_", " ")}
                  </span>
                </div>

                {a.message && (
                  <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-xs">
                    <p className="text-neutral-500">
                      In reply to {from?.name ?? from?.address ?? "unknown"}
                      {a.message.subject ? ` — ${a.message.subject}` : ""}
                    </p>
                    <p className="mt-1 text-neutral-400">{a.message.snippet}</p>
                  </div>
                )}

                {a.statusNote && (
                  <p className="mt-2 text-xs text-red-400">{a.statusNote}</p>
                )}

                {a.body &&
                  (pending ? (
                    <textarea
                      value={edits[a.id] ?? a.body}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [a.id]: e.target.value }))
                      }
                      rows={5}
                      className="mt-3 w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-sm text-neutral-200 focus:border-neutral-500 focus:outline-none"
                    />
                  ) : (
                    <div className="mt-3 whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-300">
                      {a.subject && (
                        <p className="mb-2 text-xs text-neutral-500">{a.subject}</p>
                      )}
                      {a.body}
                    </div>
                  ))}

                {pending && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => resolve(a.id, "approve")}
                      disabled={busy === a.id}
                      className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {busy === a.id ? "Sending…" : "Approve & send"}
                    </button>
                    <button
                      onClick={() => resolve(a.id, "reject")}
                      disabled={busy === a.id}
                      className="rounded-md border border-neutral-700 px-4 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

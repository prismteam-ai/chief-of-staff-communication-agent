"use client";

import { useCallback, useEffect, useState } from "react";

const CHANNELS = [
  { id: "", label: "All" },
  { id: "gmail", label: "Gmail" },
  { id: "outlook", label: "Outlook" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "x", label: "X" },
  { id: "sms", label: "SMS" },
];

const CHANNEL_ICON: Record<string, string> = {
  gmail: "✉️",
  outlook: "📧",
  linkedin: "💼",
  x: "𝕏",
  whatsapp: "💬",
  sms: "📱",
};

interface ThreadSummary {
  id: string;
  provider: string;
  subject: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  latest: {
    snippet: string | null;
    sentAt: string;
    isOutbound: boolean;
    from: { name: string | null; address: string } | null;
    attachmentCount: number;
  } | null;
}

interface Participant {
  role: string;
  name: string | null;
  address: string;
}

interface AttachmentDto {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

interface MessageDto {
  id: string;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  sentAt: string;
  isOutbound: boolean;
  participants: Participant[];
  attachments: AttachmentDto[];
}

interface ThreadDetail {
  id: string;
  provider: string;
  subject: string | null;
  messages: MessageDto[];
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function participantLabel(p: Participant): string {
  return p.name ? `${p.name} <${p.address}>` : p.address;
}

export default function InboxView() {
  const [filter, setFilter] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selected, setSelected] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const loadThreads = useCallback(async (provider: string) => {
    const res = await fetch(`/api/inbox/threads${provider ? `?provider=${provider}` : ""}`);
    if (res.ok) {
      const data = await res.json();
      setThreads(data.threads);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    loadThreads(filter);
  }, [filter, loadThreads]);

  const openThread = async (id: string) => {
    const res = await fetch(`/api/inbox/threads/${id}`);
    if (res.ok) {
      const data = await res.json();
      setSelected(data.thread);
    }
  };

  const syncAll = async () => {
    setSyncing(true);
    setBanner(null);
    const connRes = await fetch("/api/connections");
    if (!connRes.ok) {
      setBanner("Failed to load connections");
      setSyncing(false);
      return;
    }
    const { channels } = await connRes.json();
    const connected = channels.filter(
      (c: { connection: unknown; id: string }) =>
        c.connection && !["whatsapp", "linkedin"].includes(c.id)
    );
    if (connected.length === 0) {
      setBanner("No syncable channels connected yet — connect one on the Connections page.");
      setSyncing(false);
      return;
    }

    const results: string[] = [];
    for (const ch of connected) {
      const res = await fetch(`/api/connections/${ch.id}/sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      results.push(
        res.ok ? `${ch.id}: ${data.inserted} new` : `${ch.id}: ${data.error ?? "failed"}`
      );
    }
    setBanner(results.join(" · "));
    await loadThreads(filter);
    setSyncing(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilter(c.id)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                filter === c.id
                  ? "bg-white text-neutral-900"
                  : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button
          onClick={syncAll}
          disabled={syncing}
          className="rounded-md bg-white px-4 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {banner && (
        <div className="mt-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs text-neutral-300">
          {banner}
        </div>
      )}

      <div className="mt-4 flex min-h-0 flex-1 gap-4">
        {/* Thread list */}
        <div className="w-2/5 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900">
          {loading ? (
            <p className="p-4 text-sm text-neutral-500">Loading…</p>
          ) : threads.length === 0 ? (
            <p className="p-4 text-sm text-neutral-500">
              No messages yet. Hit “Sync now” to ingest from your connected channels.
            </p>
          ) : (
            threads.map((t) => (
              <button
                key={t.id}
                onClick={() => openThread(t.id)}
                className={`block w-full border-b border-neutral-800 px-4 py-3 text-left transition hover:bg-neutral-800 ${
                  selected?.id === t.id ? "bg-neutral-800" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span>{CHANNEL_ICON[t.provider] ?? "🔌"}</span>
                    <span className="truncate text-sm font-medium">
                      {t.subject || t.latest?.from?.name || t.latest?.from?.address || "(no subject)"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {formatTime(t.lastMessageAt)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="truncate text-xs text-neutral-400">
                    {t.latest?.isOutbound ? "You: " : ""}
                    {t.latest?.snippet ?? ""}
                  </p>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
                    {t.latest && t.latest.attachmentCount > 0 && <span>📎</span>}
                    {t.messageCount > 1 && <span>{t.messageCount}</span>}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Thread detail */}
        <div className="flex-1 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              Select a thread to read it
            </div>
          ) : (
            <div className="p-5">
              <div className="flex items-center gap-2">
                <span className="text-xl">{CHANNEL_ICON[selected.provider] ?? "🔌"}</span>
                <h2 className="text-base font-semibold">
                  {selected.subject || "(no subject)"}
                </h2>
              </div>

              <div className="mt-4 flex flex-col gap-4">
                {selected.messages.map((m) => {
                  const from = m.participants.find((p) => p.role === "from");
                  const to = m.participants.filter((p) => p.role === "to");
                  const cc = m.participants.filter((p) => p.role === "cc");
                  return (
                    <div
                      key={m.id}
                      className={`rounded-lg border p-4 ${
                        m.isOutbound
                          ? "border-blue-900 bg-blue-950/30"
                          : "border-neutral-800 bg-neutral-950"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 text-xs">
                          <p className="font-medium text-neutral-200">
                            {from ? participantLabel(from) : "Unknown sender"}
                            {m.isOutbound && (
                              <span className="ml-2 rounded bg-blue-900 px-1.5 py-0.5 text-[10px] text-blue-200">
                                sent
                              </span>
                            )}
                          </p>
                          {to.length > 0 && (
                            <p className="mt-0.5 truncate text-neutral-500">
                              to {to.map(participantLabel).join(", ")}
                            </p>
                          )}
                          {cc.length > 0 && (
                            <p className="truncate text-neutral-500">
                              cc {cc.map(participantLabel).join(", ")}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {new Date(m.sentAt).toLocaleString()}
                        </span>
                      </div>

                      <div className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-300">
                        {m.body ?? m.snippet ?? ""}
                      </div>

                      {m.attachments.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {m.attachments.map((a) => (
                            <span
                              key={a.id}
                              className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
                            >
                              📎 {a.filename}
                              {a.sizeBytes ? (
                                <span className="text-neutral-500">
                                  {formatBytes(a.sizeBytes)}
                                </span>
                              ) : null}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

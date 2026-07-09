"use client";

import { useRef, useState } from "react";
import type {
  AgentEvent,
  AgentResult,
  ContextPack,
  InboxMessage,
} from "@/lib/types";
import { channelMeta } from "./channels";
import Inbox from "./Inbox";
import AgentTrace from "./AgentTrace";
import ContextPanel from "./ContextPanel";
import ApprovalCard from "./ApprovalCard";

export default function Workspace({ role }: { role: string }) {
  const [selected, setSelected] = useState<InboxMessage | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [context, setContext] = useState<ContextPack | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [channel, setChannel] = useState("gmail");
  const abortRef = useRef<AbortController | null>(null);
  const canSend = role === "owner";

  async function loadContext(id: string) {
    setCtxLoading(true);
    setContext(null);
    try {
      const r = await fetch(`/api/messages/${encodeURIComponent(id)}/context`);
      if (r.ok) setContext(await r.json());
    } finally {
      setCtxLoading(false);
    }
  }

  async function runStream(body: object, forId: string | null) {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setEvents([]);
    setResult(null);
    setRunning(true);

    try {
      const res = await fetch("/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const dataLine = part
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const ev = JSON.parse(dataLine.slice(6)) as AgentEvent;
          if (ev.type === "result") setResult(ev.result);
          else if (ev.type === "context" && forId === null && !context)
            setContext(ev.context);
          else setEvents((prev) => [...prev, ev]);
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setEvents((prev) => [
          ...prev,
          { type: "error", message: String(e) },
        ]);
      }
    } finally {
      setRunning(false);
    }
  }

  function selectMessage(m: InboxMessage) {
    setSelected(m);
    loadContext(m.id);
    runStream({ message_id: m.id }, m.id);
  }

  function askCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!draftText.trim()) return;
    const custom: InboxMessage = {
      id: "ui:custom",
      channel: channel as InboxMessage["channel"],
      thread_id: "ui:custom",
      sender: { name: "You (custom)", handle: null, email: null },
      subject: null,
      snippet: draftText,
      timestamp: new Date().toISOString(),
      awaiting: false,
      overdue: false,
    };
    setSelected(custom);
    setContext(null);
    runStream({ channel, body: draftText, sender: "custom@demo" }, null);
    setDraftText("");
  }

  const meta = selected ? channelMeta(selected.channel) : null;

  return (
    <div className="flex-1 grid grid-cols-[300px_1fr_360px] min-h-0">
      {/* Inbox */}
      <div className="border-r border-[var(--color-border)] min-h-0">
        <Inbox selectedId={selected?.id ?? null} onSelect={selectMessage} />
      </div>

      {/* Chat + trace */}
      <div className="flex flex-col min-h-0">
        <div className="scroll flex-1 p-4 space-y-4">
          {selected ? (
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <span style={{ color: meta?.color }}>{meta?.glyph}</span>
                <span className="text-sm font-semibold">
                  {selected.sender.name}
                </span>
                <span className="chip ml-auto">{meta?.label}</span>
              </div>
              {selected.subject && (
                <div className="text-sm font-medium">{selected.subject}</div>
              )}
              <p className="text-sm text-[var(--color-muted)] mt-1 whitespace-pre-wrap">
                {selected.snippet}
              </p>
            </div>
          ) : (
            <div className="text-sm text-[var(--color-muted)] mt-8 text-center">
              Pick a message from the inbox, or ask your Chief of Staff below.
            </div>
          )}

          {(events.length > 0 || running) && (
            <AgentTrace events={events} running={running} />
          )}

          {result && selected && (
            <ApprovalCard result={result} message={selected} canSend={canSend} />
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={askCustom}
          className="border-t border-[var(--color-border)] p-3 flex gap-2 shrink-0"
        >
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-2 text-sm"
          >
            <option value="gmail">Gmail</option>
            <option value="x">X</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <input
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="Paste a message to triage, or ask the CoS…"
            className="flex-1 rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button type="submit" disabled={running} className="btn btn-primary">
            Run
          </button>
        </form>
      </div>

      {/* Context */}
      <div className="border-l border-[var(--color-border)] flex flex-col min-h-0">
        <div className="px-3 py-2.5 border-b border-[var(--color-border)] shrink-0">
          <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">
            Context
          </span>
        </div>
        <ContextPanel context={context} loading={ctxLoading} />
      </div>
    </div>
  );
}

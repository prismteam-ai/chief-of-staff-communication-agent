"use client";

import { useCallback, useEffect, useState } from "react";

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  message: { label: "Communication", cls: "bg-sky-900/60 text-sky-300" },
  asana_project: { label: "Asana project", cls: "bg-violet-900/60 text-violet-300" },
  asana_task: { label: "Asana task", cls: "bg-violet-900/60 text-violet-300" },
  preference: { label: "Preference", cls: "bg-amber-900/60 text-amber-300" },
  org: { label: "Org knowledge", cls: "bg-emerald-900/60 text-emerald-300" },
  agent: { label: "Agent config", cls: "bg-neutral-800 text-neutral-300" },
};

interface Item {
  id: string;
  kind: string;
  title: string;
  content: string;
  updatedAt: string;
}

interface Result {
  source: string;
  sourceId: string;
  title: string | null;
  content: string;
  score: number;
}

export default function KnowledgeView() {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [form, setForm] = useState({ kind: "org", title: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/knowledge");
      if (res.ok) setItems((await res.json()).items);
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/rag/search?q=${encodeURIComponent(query.trim())}`);
      if (res.ok) setResults((await res.json()).results);
    } catch {
      setBanner("Search failed — try again");
    } finally {
      setSearching(false);
    }
  };

  const add = async () => {
    if (!form.title.trim() || !form.content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm({ kind: form.kind, title: "", content: "" });
        await load();
      } else {
        setBanner((await res.json().catch(() => ({}))).error ?? "Failed to save");
      }
    } catch {
      setBanner("Network error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await fetch(`/api/knowledge/${id}`, { method: "DELETE" });
      await load();
    } catch {}
  };

  const reindex = async () => {
    setReindexing(true);
    setBanner(null);
    try {
      const res = await fetch("/api/rag/search", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setBanner(
        res.ok
          ? `Index refreshed: ${data.scanned} sources scanned, ${data.written} chunks updated${data.embedded ? `, ${data.embedded} embedded` : ""}`
          : "Reindex failed"
      );
    } catch {
      setBanner("Network error");
    } finally {
      setReindexing(false);
    }
  };

  const orgItems = items.filter((i) => i.kind === "org");
  const prefItems = items.filter((i) => i.kind === "preference");

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Knowledge</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Everything your agents can retrieve when drafting replies: communication
            history, Asana context, your preferences, and organizational knowledge.
          </p>
        </div>
        <button
          onClick={reindex}
          disabled={reindexing}
          className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {reindexing ? "Indexing…" : "Rebuild index"}
        </button>
      </div>

      {banner && (
        <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs text-neutral-300">
          {banner}
        </div>
      )}

      {/* Search */}
      <div className="mt-6 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Ask the knowledge base — e.g. 'invoice reconciliation status' or 'what did Bruno say about sign-off?'"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          onClick={search}
          disabled={searching || !query.trim()}
          className="rounded-md bg-white px-5 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          {searching ? "…" : "Search"}
        </button>
      </div>

      {results !== null && (
        <div className="mt-4 flex flex-col gap-2">
          {results.length === 0 ? (
            <p className="text-sm text-neutral-500">No matches in the knowledge index.</p>
          ) : (
            results.map((r, i) => {
              const badge = SOURCE_BADGE[r.source] ?? { label: r.source, cls: "bg-neutral-800 text-neutral-300" };
              return (
                <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium text-neutral-200">
                      {r.title ?? "(untitled)"}
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs ${badge.cls}`}>
                        {badge.label}
                      </span>
                      <span className="text-xs text-neutral-600">
                        {(r.score * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-xs text-neutral-400">
                    {r.content.slice(0, 400)}
                    {r.content.length > 400 ? "…" : ""}
                  </p>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Add knowledge */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h3 className="text-sm font-semibold">Add knowledge</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Org knowledge: facts about your company, clients, products, processes.
            Preferences: how you like things handled.
          </p>
          <div className="mt-3 flex gap-2">
            {[
              { v: "org", label: "Org knowledge" },
              { v: "preference", label: "Preference" },
            ].map((opt) => (
              <button
                key={opt.v}
                onClick={() => setForm((f) => ({ ...f, kind: opt.v }))}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  form.kind === opt.v
                    ? "bg-white text-neutral-900"
                    : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder={form.kind === "org" ? "e.g. Refund policy" : "e.g. Escalation preference"}
            className="mt-3 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <textarea
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            rows={4}
            placeholder={
              form.kind === "org"
                ? "e.g. Refunds are approved within 14 days of purchase. Enterprise clients contact accounts@…"
                : "e.g. Always CC me on anything involving contract changes. Never commit to deadlines without checking Asana."
            }
            className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <button
            onClick={add}
            disabled={saving || !form.title.trim() || !form.content.trim()}
            className="mt-3 rounded-md bg-white px-4 py-2 text-xs font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add to knowledge base"}
          </button>
        </div>

        {/* Existing items */}
        <div className="flex flex-col gap-4">
          {[
            { label: "Organizational knowledge", list: orgItems },
            { label: "Preferences", list: prefItems },
          ].map((section) => (
            <div key={section.label} className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <h3 className="text-sm font-semibold">{section.label}</h3>
              {section.list.length === 0 ? (
                <p className="mt-2 text-xs text-neutral-500">Nothing here yet.</p>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  {section.list.map((i) => (
                    <div
                      key={i.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-neutral-200">{i.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-neutral-500">{i.content}</p>
                      </div>
                      <button
                        onClick={() => remove(i.id)}
                        className="shrink-0 text-xs text-neutral-600 transition hover:text-red-400"
                      >
                        
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

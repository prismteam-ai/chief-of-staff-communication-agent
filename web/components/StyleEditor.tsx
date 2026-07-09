"use client";

import { useEffect, useState } from "react";
import type { StyleOverrides, StyleResponse } from "@/lib/types";

const EMPTY: StyleOverrides = { voice: "", signoff: "", rules: [], examples: [] };

const inputCls =
  "w-full rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] " +
  "px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

/** A list of free-text rows the owner can add to / edit / remove. */
function ListEditor({
  label,
  hint,
  placeholder,
  multiline,
  items,
  canEdit,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  multiline?: boolean;
  items: string[];
  canEdit: boolean;
  onChange: (next: string[]) => void;
}) {
  function set(i: number, v: string) {
    const next = [...items];
    next[i] = v;
    onChange(next);
  }
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-semibold">{label}</label>
        {canEdit && (
          <button
            className="btn btn-ghost !py-1 !px-2 text-xs"
            onClick={() => onChange([...items, ""])}
          >
            + Add
          </button>
        )}
      </div>
      <p className="text-xs text-[var(--color-muted)] mb-2">{hint}</p>
      <div className="flex flex-col gap-2">
        {items.length === 0 && (
          <p className="text-xs text-[var(--color-muted)] italic">None yet.</p>
        )}
        {items.map((item, i) => (
          <div key={i} className="flex gap-2 items-start">
            {multiline ? (
              <textarea
                className={inputCls + " min-h-[3rem] resize-y"}
                value={item}
                placeholder={placeholder}
                disabled={!canEdit}
                onChange={(e) => set(i, e.target.value)}
              />
            ) : (
              <input
                className={inputCls}
                value={item}
                placeholder={placeholder}
                disabled={!canEdit}
                onChange={(e) => set(i, e.target.value)}
              />
            )}
            {canEdit && (
              <button
                className="btn btn-ghost !py-2 !px-2 shrink-0"
                title="Remove"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StyleEditor({ role }: { role: string }) {
  const [data, setData] = useState<StyleResponse | null>(null);
  const [form, setForm] = useState<StyleOverrides>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const canEdit = role === "owner";

  function load() {
    fetch("/api/style")
      .then((r) => r.json())
      .then((d: StyleResponse) => {
        setData(d);
        setForm(d.overrides ?? EMPTY);
      });
  }
  useEffect(load, []);

  function patch(p: Partial<StyleOverrides>) {
    setForm((f) => ({ ...f, ...p }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    const res = await fetch("/api/style", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        rules: form.rules.map((r) => r.trim()).filter(Boolean),
        examples: form.examples.map((e) => e.trim()).filter(Boolean),
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      load();
    }
  }

  const profile = data?.profile ?? null;

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold">Style</h1>
        {canEdit && (
          <button onClick={save} disabled={saving} className="btn btn-primary">
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        )}
      </div>
      <p className="text-sm text-[var(--color-muted)] mb-5">
        Drafts are written in your voice. Style is learned from your sent messages, and the
        rules and examples below are pinned into every draft verbatim. Good examples matter
        more than many.
      </p>

      {!canEdit && (
        <p className="text-sm mb-4" style={{ color: "var(--color-warn)" }}>
          Read-only role — sign in as owner to edit your style.
        </p>
      )}

      {/* Learned profile preview */}
      {profile && (
        <div className="card p-4 mb-6">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)] mb-2">
            Learned profile (from your sent messages + the pins below)
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="chip">tone: {profile.tone}</span>
            <span className="chip">formality: {profile.formality}</span>
            <span className="chip">signoff: {profile.signoff || "none"}</span>
            <span className="chip">emoji: {profile.uses_emoji ? "yes" : "no"}</span>
            <span className="chip">~{profile.avg_sentence_words} words/sentence</span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-6">
        <div>
          <label className="text-sm font-semibold">Voice</label>
          <p className="text-xs text-[var(--color-muted)] mb-2">
            One or two sentences describing how you write.
          </p>
          <textarea
            className={inputCls + " min-h-[4rem] resize-y"}
            value={form.voice}
            disabled={!canEdit}
            placeholder="e.g. Concise and direct. Facts over adjectives. No filler."
            onChange={(e) => patch({ voice: e.target.value })}
          />
        </div>

        <div>
          <label className="text-sm font-semibold">Sign-off</label>
          <p className="text-xs text-[var(--color-muted)] mb-2">
            How you end messages (per channel is fine as free text).
          </p>
          <input
            className={inputCls}
            value={form.signoff}
            disabled={!canEdit}
            placeholder="e.g. Sign off as 'Dmitrii' on email; none on X/WhatsApp."
            onChange={(e) => patch({ signoff: e.target.value })}
          />
        </div>

        <ListEditor
          label="Rules"
          hint="Explicit do/don't rules the draft must obey verbatim."
          placeholder="e.g. No em dashes. Lead with the point."
          items={form.rules}
          canEdit={canEdit}
          onChange={(rules) => patch({ rules })}
        />

        <ListEditor
          label="Example messages"
          hint="Short, real messages in your voice. These lead the few-shot at draft time."
          placeholder="e.g. Sam, ship it today. I read the diff, it's good."
          multiline
          items={form.examples}
          canEdit={canEdit}
          onChange={(examples) => patch({ examples })}
        />
      </div>
    </div>
  );
}

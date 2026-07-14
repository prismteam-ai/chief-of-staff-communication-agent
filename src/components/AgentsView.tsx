"use client";

import { useCallback, useEffect, useState } from "react";

const STYLES = ["professional", "formal", "casual", "friendly", "direct", "empathetic"];
const TONES = ["neutral", "warm", "concise", "playful", "assertive", "authoritative"];
const ALL_CHANNELS = [
  { id: "gmail", label: "Gmail" },
  { id: "outlook", label: "Outlook" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "x", label: "X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "sms", label: "SMS" },
  { id: "asana", label: "Asana" },
];

interface Agent {
  id: string;
  name: string;
  description: string | null;
  communicationStyle: string;
  toneOfVoice: string;
  customInstructions: string | null;
  autoReply: boolean;
  mode: string;
  channels: string[];
  contactPolicy: string;
  contactList: string[];
  skills: string[];
  isActive: boolean;
}

interface FormState {
  name: string;
  description: string;
  communicationStyle: string;
  toneOfVoice: string;
  customInstructions: string;
  autoReply: boolean;
  mode: string;
  channels: string[];
  contactPolicy: string;
  contactListText: string;
  skills: string[];
  isActive: boolean;
}

const SKILL_OPTIONS = [
  {
    id: "asana_status_report",
    label: "Asana status reports",
    hint: "When someone asks for a project update, pull live progress, milestones and due dates from Asana and reply with real data.",
  },
  {
    id: "asana_create_task",
    label: "Asana task creation",
    hint: "When someone asks to add something, draft an Asana task in the matching project — created on approval (or instantly on autopilot).",
  },
];

const emptyForm: FormState = {
  name: "",
  description: "",
  communicationStyle: "professional",
  toneOfVoice: "neutral",
  customInstructions: "",
  autoReply: false,
  mode: "hitl",
  channels: [],
  contactPolicy: "all",
  contactListText: "",
  skills: [],
  isActive: true,
};

function agentToForm(a: Agent): FormState {
  return {
    name: a.name,
    description: a.description ?? "",
    communicationStyle: a.communicationStyle,
    toneOfVoice: a.toneOfVoice,
    customInstructions: a.customInstructions ?? "",
    autoReply: a.autoReply,
    mode: a.mode,
    channels: a.channels,
    contactPolicy: a.contactPolicy,
    contactListText: a.contactList.join("\n"),
    skills: a.skills ?? [],
    isActive: a.isActive,
  };
}

function formToPayload(f: FormState) {
  return {
    name: f.name,
    description: f.description,
    communicationStyle: f.communicationStyle,
    toneOfVoice: f.toneOfVoice,
    customInstructions: f.customInstructions,
    autoReply: f.mode === "autopilot",
    mode: f.mode,
    channels: f.channels,
    contactPolicy: f.contactPolicy,
    contactList: f.contactListText.split("\n").map((s) => s.trim()).filter(Boolean),
    skills: f.skills,
    isActive: f.isActive,
  };
}

export default function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connectedChannels, setConnectedChannels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [agentsRes, connRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/connections"),
    ]);
    if (agentsRes.ok) setAgents((await agentsRes.json()).agents);
    if (connRes.ok) {
      const { channels } = await connRes.json();
      setConnectedChannels(
        channels
          .filter((c: { connection: unknown }) => c.connection)
          .map((c: { id: string }) => c.id)
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setForm(emptyForm);
    setError(null);
    setEditing("new");
  };
  const openEdit = (a: Agent) => {
    setForm(agentToForm(a));
    setError(null);
    setEditing(a);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const isNew = editing === "new";
    const res = await fetch(isNew ? "/api/agents" : `/api/agents/${(editing as Agent).id}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToPayload(form)),
    });
    if (res.ok) {
      setEditing(null);
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to save agent");
    }
    setSaving(false);
  };

  const remove = async (id: string) => {
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    await load();
  };

  const toggleActive = async (a: Agent) => {
    await fetch(`/api/agents/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !a.isActive }),
    });
    await load();
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Your agents</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Define who speaks for you: their voice, autonomy, channels, and who they may
            talk to.
          </p>
        </div>
        <button
          onClick={openNew}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200"
        >
          + New agent
        </button>
      </div>

      {loading ? (
        <p className="mt-8 text-sm text-neutral-500">Loading agents…</p>
      ) : agents.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-700 p-10 text-center">
          <p className="text-sm text-neutral-400">
            No agents yet. Create your first communications agent.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <div
              key={a.id}
              className={`flex flex-col rounded-xl border bg-neutral-900 p-5 ${
                a.isActive ? "border-neutral-800" : "border-neutral-800 opacity-60"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div>
                    <h3 className="font-medium">{a.name}</h3>
                    <p className="text-xs text-neutral-500 capitalize">
                      {a.communicationStyle} · {a.toneOfVoice}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs ${
                    a.mode === "autopilot"
                      ? "bg-purple-900/60 text-purple-300"
                      : "bg-sky-900/60 text-sky-300"
                  }`}
                >
                  {a.mode === "autopilot" ? "Autopilot" : "Human approval"}
                </span>
              </div>

              {a.description && (
                <p className="mt-3 text-xs text-neutral-400">{a.description}</p>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                {a.channels.length === 0 ? (
                  <span className="text-xs text-neutral-600">No channels assigned</span>
                ) : (
                  a.channels.map((c) => {
                    const ch = ALL_CHANNELS.find((x) => x.id === c);
                    return (
                      <span
                        key={c}
                        className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300"
                      >
                        {ch?.label ?? c}
                      </span>
                    );
                  })
                )}
              </div>

              <div className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-500">
                {a.skills?.includes("asana_status_report") && <span>Asana status</span>}
                {a.skills?.includes("asana_create_task") && <span>Asana tasks</span>}
                <span>
                  {a.contactPolicy === "all"
                    ? "anyone"
                    : a.contactPolicy === "allowlist"
                      ? `only ${a.contactList.length} allowed`
                      : `${a.contactList.length} blocked`}
                </span>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => openEdit(a)}
                  className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
                >
                  Edit
                </button>
                <button
                  onClick={() => toggleActive(a)}
                  className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
                >
                  {a.isActive ? "Pause" : "Activate"}
                </button>
                <button
                  onClick={() => remove(a.id)}
                  className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-950"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 py-10">
          <form
            onSubmit={save}
            className="w-full max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-900 p-6"
          >
            <div className="flex items-start justify-between">
              <h3 className="text-lg font-semibold">
                {editing === "new" ? "Create agent" : `Edit ${form.name || "agent"}`}
              </h3>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-neutral-500 hover:text-white"
              >
                
              </button>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-xs text-neutral-300">
                Name *
                <input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  required
                  placeholder="e.g. Press Inquiries Agent"
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
                />
              </label>
              <label className="text-xs text-neutral-300">
                Description
                <input
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="What is this agent responsible for?"
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
                />
              </label>

              <label className="text-xs text-neutral-300">
                Communication style
                <select
                  value={form.communicationStyle}
                  onChange={(e) => set("communicationStyle", e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm capitalize text-white focus:border-neutral-500 focus:outline-none"
                >
                  {STYLES.map((s) => (
                    <option key={s} value={s} className="capitalize">
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-neutral-300">
                Tone of voice
                <select
                  value={form.toneOfVoice}
                  onChange={(e) => set("toneOfVoice", e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm capitalize text-white focus:border-neutral-500 focus:outline-none"
                >
                  {TONES.map((t) => (
                    <option key={t} value={t} className="capitalize">
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="mt-4 block text-xs text-neutral-300">
              Custom instructions
              <textarea
                value={form.customInstructions}
                onChange={(e) => set("customInstructions", e.target.value)}
                rows={3}
                placeholder="Extra guidance, e.g. 'Always sign off as the Communications Office. Never discuss pricing.'"
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
            </label>

            {/* Autonomy */}
            <fieldset className="mt-5 rounded-lg border border-neutral-800 p-4">
              <legend className="px-1 text-xs font-semibold uppercase text-neutral-500">
                Autonomy
              </legend>
              <div className="flex flex-col gap-3">
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="mode"
                    checked={form.mode === "hitl"}
                    onChange={() => set("mode", "hitl")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">Human-in-the-loop</span>
                    <span className="block text-xs text-neutral-400">
                      Every outgoing message requires your approval before it is sent.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="mode"
                    checked={form.mode === "autopilot"}
                    onChange={() => set("mode", "autopilot")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">Autopilot</span>
                    <span className="block text-xs text-neutral-400">
                      The agent acts on its own within its rules — no approval needed.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            {/* Channels */}
            <fieldset className="mt-5 rounded-lg border border-neutral-800 p-4">
              <legend className="px-1 text-xs font-semibold uppercase text-neutral-500">
                Available channels
              </legend>
              <div className="flex flex-wrap gap-2">
                {ALL_CHANNELS.map((c) => {
                  const checked = form.channels.includes(c.id);
                  const connected = connectedChannels.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition ${
                        checked
                          ? "border-white bg-white text-neutral-900"
                          : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          set(
                            "channels",
                            e.target.checked
                              ? [...form.channels, c.id]
                              : form.channels.filter((x) => x !== c.id)
                          )
                        }
                        className="hidden"
                      />
                      {c.label}
                      {!connected && (
                        <span className={checked ? "text-neutral-600" : "text-amber-500"}>
                          (not connected)
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Skills */}
            <fieldset className="mt-5 rounded-lg border border-neutral-800 p-4">
              <legend className="px-1 text-xs font-semibold uppercase text-neutral-500">
                Skills (Asana integration)
              </legend>
              <div className="flex flex-col gap-3">
                {SKILL_OPTIONS.map((s) => {
                  const checked = form.skills.includes(s.id);
                  return (
                    <label key={s.id} className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          set(
                            "skills",
                            e.target.checked
                              ? [...form.skills, s.id]
                              : form.skills.filter((x) => x !== s.id)
                          )
                        }
                        className="mt-0.5"
                      />
                      <span className="text-sm text-neutral-200">
                        {s.label}
                        <span className="mt-0.5 block text-xs text-neutral-500">{s.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Contact rules */}
            <fieldset className="mt-5 rounded-lg border border-neutral-800 p-4">
              <legend className="px-1 text-xs font-semibold uppercase text-neutral-500">
                Who can this agent communicate with?
              </legend>
              <div className="flex flex-col gap-2 text-sm">
                {[
                  { v: "all", label: "Everyone" },
                  { v: "allowlist", label: "Only these people" },
                  { v: "blocklist", label: "Everyone except these people" },
                ].map((opt) => (
                  <label key={opt.v} className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="contactPolicy"
                      checked={form.contactPolicy === opt.v}
                      onChange={() => set("contactPolicy", opt.v)}
                    />
                    {opt.label}
                  </label>
                ))}
                {form.contactPolicy !== "all" && (
                  <textarea
                    value={form.contactListText}
                    onChange={(e) => set("contactListText", e.target.value)}
                    rows={4}
                    placeholder={"One per line — emails, phone numbers or handles:\njane@example.com\n+15551234567\n@journalist"}
                    className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
                  />
                )}
              </div>
            </fieldset>

            {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-white px-4 py-2 text-xs font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
              >
                {saving ? "Saving…" : editing === "new" ? "Create agent" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

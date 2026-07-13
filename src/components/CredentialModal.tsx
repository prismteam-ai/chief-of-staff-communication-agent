"use client";

import { useState } from "react";
import type { ChannelDto } from "@/components/ConnectionsDashboard";

export default function CredentialModal({
  channel,
  onClose,
  onConnected,
}: {
  channel: ChannelDto;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch(`/api/connections/${channel.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (res.ok) {
      onConnected();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Connection failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Connect {channel.name}</h3>
            <p className="mt-1 text-xs text-neutral-400">{channel.description}</p>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            ✕
          </button>
        </div>

        {channel.helpUrl && (
          <a
            href={channel.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs text-blue-400 hover:underline"
          >
            Where do I find these credentials?
          </a>
        )}

        <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
          {(channel.fields ?? []).map((field) => (
            <label key={field.name} className="text-xs text-neutral-300">
              {field.label}
              <input
                type={field.secret ? "password" : "text"}
                placeholder={field.placeholder}
                value={values[field.name] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [field.name]: e.target.value }))
                }
                required
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
            </label>
          ))}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
            >
              {submitting ? "Validating…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

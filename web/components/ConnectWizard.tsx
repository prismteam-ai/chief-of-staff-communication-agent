"use client";

import { useEffect, useState } from "react";
import { channelMeta } from "./channels";
import type { ProviderSetup } from "./providerSetup";

export default function ConnectWizard({
  setup,
  onClose,
  onConnected,
}: {
  setup: ProviderSetup;
  onClose: () => void;
  onConnected: () => void;
}) {
  const meta = channelMeta(setup.provider);
  const fields = setup.fields;
  const lastFieldStep = fields.length; // steps: 0 intro, 1..N fields, N+1 review
  const reviewStep = fields.length + 1;

  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const field = step >= 1 && step <= lastFieldStep ? fields[step - 1] : null;
  const canNext = !field || field.optional || (values[field.key] ?? "").trim().length > 0;

  async function connect() {
    setBusy(true);
    setError("");
    const credentials = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.trim())
    );
    const res = await fetch(`/api/connections/${setup.provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "real", credentials }),
    });
    setBusy(false);
    if (res.ok) {
      onConnected();
      onClose();
    } else {
      const j = await res.json().catch(() => ({}));
      setError(j.detail ?? j.error ?? `failed (${res.status})`);
    }
  }

  const totalSteps = fields.length + 2;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(4,7,12,0.7)" }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-0 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
          <span className="text-lg" style={{ color: meta.color }}>
            {meta.glyph}
          </span>
          <span className="font-semibold">{setup.title}</span>
          <span className="text-xs text-[var(--color-muted)] ml-2">
            Step {step + 1} of {totalSteps}
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-text)] text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* progress dots */}
        <div className="flex gap-1 px-5 pt-3">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <span
              key={i}
              className="h-1 flex-1 rounded-full"
              style={{
                background:
                  i <= step ? "var(--color-accent)" : "var(--color-border)",
              }}
            />
          ))}
        </div>

        {/* body */}
        <div className="px-5 py-4 min-h-[190px]">
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-muted)]">{setup.blurb}</p>
              <a
                href={setup.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="chip"
                style={{ color: "var(--color-accent)" }}
              >
                ↗ {setup.docsLabel}
              </a>
              <p className="text-xs text-[var(--color-muted)]">
                You’ll enter {fields.length} value
                {fields.length === 1 ? "" : "s"}. Prefer no setup? Close this and
                use Mock.
              </p>
            </div>
          )}

          {field && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-sm font-semibold">{field.label}</label>
                {field.optional && <span className="chip">optional</span>}
              </div>
              <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                {field.instruction}
              </p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  type={field.secret && !reveal[field.key] ? "password" : "text"}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.key]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canNext) setStep((s) => s + 1);
                  }}
                  className="flex-1 rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
                {field.secret && (
                  <button
                    type="button"
                    onClick={() =>
                      setReveal((r) => ({ ...r, [field.key]: !r[field.key] }))
                    }
                    className="btn btn-ghost"
                  >
                    {reveal[field.key] ? "Hide" : "Show"}
                  </button>
                )}
              </div>
            </div>
          )}

          {step === reviewStep && (
            <div className="space-y-2">
              <p className="text-sm font-semibold">Review & connect</p>
              <ul className="space-y-1">
                {fields.map((f) => {
                  const v = (values[f.key] ?? "").trim();
                  return (
                    <li
                      key={f.key}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-[var(--color-muted)]">{f.label}</span>
                      <span>
                        {v
                          ? f.secret
                            ? "•".repeat(Math.min(v.length, 8)) + " set"
                            : v
                          : f.optional
                          ? "— skipped"
                          : "— missing"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-[var(--color-muted)]">
                Credentials are stored server-side and never exposed to the
                browser. Connecting switches this provider to real mode.
              </p>
              {error && (
                <p className="text-sm" style={{ color: "var(--color-bad)" }}>
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          {step > 0 && (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="btn btn-ghost"
              disabled={busy}
            >
              Back
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="btn btn-ghost" disabled={busy}>
              Cancel
            </button>
            {step < reviewStep ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canNext}
                className="btn btn-primary"
              >
                {step === 0 ? "Get started" : "Next"}
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={busy}
                className="btn btn-primary"
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

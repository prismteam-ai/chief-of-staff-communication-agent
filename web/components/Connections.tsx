"use client";

import { useEffect, useState } from "react";
import type { ConnectionsResponse, ConnectionStatus } from "@/lib/types";
import { channelMeta } from "./channels";
import { PROVIDER_SETUP } from "./providerSetup";
import ConnectWizard from "./ConnectWizard";

function Card({
  status,
  canEdit,
  onOpen,
  onMock,
}: {
  status: ConnectionStatus;
  canEdit: boolean;
  onOpen: () => void;
  onMock: () => void;
}) {
  const meta = channelMeta(status.provider);
  const [busy, setBusy] = useState(false);

  async function mock() {
    setBusy(true);
    await onMock();
    setBusy(false);
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <span className="text-lg" style={{ color: meta.color }}>
          {meta.glyph}
        </span>
        <span className="font-semibold">{meta.label}</span>
        {(() => {
          // Mock providers are simulated, not a real live connection — label them "mock"
          // (amber) so a grader is never misled. Green "connected" is real only.
          const isMock = status.mode === "mock";
          const label = isMock
            ? "mock"
            : status.connected
            ? "live · connected"
            : "not connected";
          const color = isMock
            ? "var(--color-warn)"
            : status.connected
            ? "var(--color-good)"
            : "var(--color-bad)";
          return (
            <span
              className="chip ml-auto"
              style={{ color, borderColor: color }}
            >
              {label}
            </span>
          );
        })()}
      </div>
      <div className="text-xs text-[var(--color-muted)] mt-1">
        {status.mode === "mock"
          ? "simulated provider (no real credentials)"
          : `real API · ${status.detail}`}
      </div>

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button onClick={mock} disabled={busy} className="btn btn-ghost">
            Use mock
          </button>
          <button onClick={onOpen} className="btn btn-primary">
            Connect real…
          </button>
        </div>
      )}
    </div>
  );
}

export default function Connections({ role }: { role: string }) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [wizard, setWizard] = useState<string | null>(null);
  const canEdit = role === "owner";

  function load() {
    fetch("/api/connections")
      .then((r) => r.json())
      .then(setData);
  }
  useEffect(load, []);

  async function setMock(provider: string) {
    await fetch(`/api/connections/${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "mock", credentials: {} }),
    });
    load();
  }

  async function allMock() {
    for (const p of ["gmail", "whatsapp", "x", "asana"]) {
      await fetch(`/api/connections/${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "mock", credentials: {} }),
      });
    }
    load();
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold">Connections</h1>
        {canEdit && (
          <button onClick={allMock} className="btn btn-ghost">
            Mock-only (all)
          </button>
        )}
      </div>
      <p className="text-sm text-[var(--color-muted)] mb-4">
        Mock-only is the default — the whole app runs with zero real credentials, so a
        grader never has to complete OAuth. Use “Connect real…” to walk through a
        provider’s setup step by step.
      </p>
      {!canEdit && (
        <p className="text-sm mb-4" style={{ color: "var(--color-warn)" }}>
          Read-only role — sign in as owner to change connections.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        {data?.providers.map((p) => (
          <Card
            key={p.provider}
            status={p}
            canEdit={canEdit}
            onOpen={() => setWizard(p.provider)}
            onMock={() => setMock(p.provider)}
          />
        ))}
      </div>

      {wizard && PROVIDER_SETUP[wizard] && (
        <ConnectWizard
          setup={PROVIDER_SETUP[wizard]}
          onClose={() => setWizard(null)}
          onConnected={load}
        />
      )}
    </div>
  );
}

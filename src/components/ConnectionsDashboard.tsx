"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import CredentialModal from "@/components/CredentialModal";

export interface CredentialFieldDto {
  name: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

export interface ChannelDto {
  id: string;
  name: string;
  description: string;
  kind: "oauth" | "credentials";
  fields?: CredentialFieldDto[];
  helpUrl?: string;
  configured: boolean;
  connection: {
    status: string;
    accountLabel: string | null;
    lastCheckAt: string | null;
    lastError: string | null;
  } | null;
}

const ICONS: Record<string, string> = {
  gmail: "✉️",
  outlook: "📧",
  linkedin: "💼",
  x: "𝕏",
  whatsapp: "💬",
  sms: "📱",
};

function StatusBadge({ channel }: { channel: ChannelDto }) {
  if (!channel.connection) {
    return (
      <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-400">
        Not connected
      </span>
    );
  }
  const { status } = channel.connection;
  const styles: Record<string, string> = {
    connected: "bg-emerald-900/60 text-emerald-300",
    expired: "bg-amber-900/60 text-amber-300",
    error: "bg-red-900/60 text-red-300",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs capitalize ${styles[status] ?? "bg-neutral-800 text-neutral-400"}`}
    >
      {status}
    </span>
  );
}

export default function ConnectionsDashboard() {
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [modalChannel, setModalChannel] = useState<ChannelDto | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  const load = useCallback(async () => {
    const res = await fetch("/api/connections");
    if (res.ok) {
      const data = await res.json();
      setChannels(data.channels);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const error = searchParams.get("error");
    const connected = searchParams.get("connected");
    if (error) setBanner({ kind: "error", text: error });
    if (connected) setBanner({ kind: "success", text: `${connected} connected successfully.` });
    if (error || connected) router.replace("/connections");
  }, [searchParams, router]);

  const disconnect = async (id: string) => {
    setBusy(id);
    const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBanner({ kind: "error", text: data.error ?? "Failed to disconnect" });
    }
    await load();
    setBusy(null);
  };

  const testConnection = async (id: string) => {
    setBusy(id);
    const res = await fetch(`/api/connections/${id}/test`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBanner(
      res.ok
        ? { kind: "success", text: `${id} is healthy${data.label ? ` (${data.label})` : ""}.` }
        : { kind: "error", text: data.error ?? `${id} health check failed` }
    );
    await load();
    setBusy(null);
  };

  if (loading) {
    return <p className="mt-8 text-sm text-neutral-500">Loading channels…</p>;
  }

  return (
    <>
      {banner && (
        <div
          className={`mt-6 flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${
            banner.kind === "error"
              ? "border-red-800 bg-red-950/60 text-red-300"
              : "border-emerald-800 bg-emerald-950/60 text-emerald-300"
          }`}
        >
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)} className="ml-4 text-xs opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {channels.map((channel) => {
          const connected = channel.connection?.status != null;
          return (
            <div
              key={channel.id}
              className="flex flex-col rounded-xl border border-neutral-800 bg-neutral-900 p-5"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{ICONS[channel.id] ?? "🔌"}</span>
                  <div>
                    <h3 className="font-medium">{channel.name}</h3>
                    {channel.connection?.accountLabel && (
                      <p className="text-xs text-neutral-400">{channel.connection.accountLabel}</p>
                    )}
                  </div>
                </div>
                <StatusBadge channel={channel} />
              </div>

              <p className="mt-3 flex-1 text-xs text-neutral-400">{channel.description}</p>

              {channel.connection?.lastError && (
                <p className="mt-2 text-xs text-red-400">{channel.connection.lastError}</p>
              )}
              {!channel.configured && (
                <p className="mt-2 text-xs text-amber-400">
                  Provider credentials not configured — see .env.example.
                </p>
              )}

              <div className="mt-4 flex gap-2">
                {connected ? (
                  <>
                    <button
                      onClick={() => testConnection(channel.id)}
                      disabled={busy === channel.id}
                      className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {busy === channel.id ? "Working…" : "Test"}
                    </button>
                    <button
                      onClick={() => disconnect(channel.id)}
                      disabled={busy === channel.id}
                      className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-950 disabled:opacity-50"
                    >
                      Disconnect
                    </button>
                  </>
                ) : channel.kind === "oauth" ? (
                  <a
                    href={channel.configured ? `/api/connections/${channel.id}/authorize` : undefined}
                    aria-disabled={!channel.configured}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                      channel.configured
                        ? "bg-white text-neutral-900 hover:bg-neutral-200"
                        : "cursor-not-allowed bg-neutral-800 text-neutral-500"
                    }`}
                  >
                    Connect
                  </a>
                ) : (
                  <button
                    onClick={() => setModalChannel(channel)}
                    className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-200"
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {modalChannel && (
        <CredentialModal
          channel={modalChannel}
          onClose={() => setModalChannel(null)}
          onConnected={async () => {
            setModalChannel(null);
            setBanner({ kind: "success", text: `${modalChannel.name} connected successfully.` });
            await load();
          }}
        />
      )}
    </>
  );
}

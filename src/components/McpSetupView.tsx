"use client";

import { useCallback, useEffect, useState } from "react";

const TOOLS: [string, string][] = [
  ["get_dashboard_stats", "Volume, answered/pending/overdue, channel breakdown, response times"],
  ["list_unanswered", "Inbound communications still awaiting a response"],
  ["list_pending_approvals", "Drafts and Asana task proposals waiting for approval"],
  ["approve_action", "Approve and execute an action (optionally with an edited body)"],
  ["reject_action", "Dismiss a pending action"],
  ["run_agents_now", "Run the agent runtime immediately"],
  ["asana_status", "Live Asana project status report"],
  ["search_knowledge", "RAG search over communications, Asana, preferences, org knowledge"],
  ["reindex_knowledge", "Rebuild the RAG knowledge index"],
];

export default function McpSetupView() {
  const [token, setToken] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string>("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-token");
      if (res.ok) {
        const data = await res.json();
        setToken(data.token);
        setMcpUrl(data.mcpUrl);
      } else {
        setError("Could not load your MCP token.");
      }
    } catch {
      setError("Could not load your MCP token.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rotate = async () => {
    if (!confirm("Rotate the token? Any client using the current token will stop working.")) return;
    setRotating(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp-token", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setToken(data.token);
        setMcpUrl(data.mcpUrl);
        setRevealed(true);
      } else {
        setError("Rotation failed.");
      }
    } catch {
      setError("Rotation failed.");
    } finally {
      setRotating(false);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {}
  };

  const config = token
    ? JSON.stringify(
        {
          mcpServers: {
            "chief-of-comms": {
              url: mcpUrl,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2
      )
    : "";

  return (
    <div>
      <h2 className="text-xl font-semibold">MCP access</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Connect Cursor, Claude Desktop, or any MCP client to your Chief of
        Communications agents. Your personal token scopes every tool to your
        data only — treat it like a password.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Token */}
      <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Your personal token</h3>
          <div className="flex gap-2">
            <button
              onClick={() => setRevealed((v) => !v)}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
            >
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button
              onClick={() => token && copy("token", token)}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
            >
              {copied === "token" ? "Copied" : "Copy"}
            </button>
            <button
              onClick={rotate}
              disabled={rotating}
              className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-950/40 disabled:opacity-50"
            >
              {rotating ? "Rotating…" : "Rotate"}
            </button>
          </div>
        </div>
        <p className="mt-3 break-all rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">
          {token ? (revealed ? token : `${token.slice(0, 8)}${"•".repeat(24)}`) : "Loading…"}
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Rotating invalidates the previous token immediately.
        </p>
      </div>

      {/* Endpoint + config */}
      <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold">Endpoint</h3>
        <p className="mt-2 break-all rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">
          {mcpUrl || "Loading…"}
        </p>

        <div className="mt-5 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Cursor configuration</h3>
          <button
            onClick={() => config && copy("config", config)}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
          >
            {copied === "config" ? "Copied" : "Copy JSON"}
          </button>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Save as <span className="font-mono">.cursor/mcp.json</span> in a project, or{" "}
          <span className="font-mono">~/.cursor/mcp.json</span> for global use, then reload
          Cursor (Settings → MCP).
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">
          {token
            ? revealed
              ? config
              : config.replace(token, `${token.slice(0, 8)}…`)
            : "Loading…"}
        </pre>
      </div>

      {/* Tools */}
      <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold">Available tools</h3>
        <div className="mt-3 flex flex-col gap-1.5">
          {TOOLS.map(([name, desc]) => (
            <div key={name} className="flex items-baseline gap-3 text-xs">
              <span className="shrink-0 font-mono text-neutral-200">{name}</span>
              <span className="text-neutral-500">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

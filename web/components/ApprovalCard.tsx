"use client";

import { useEffect, useState } from "react";
import type { AgentResult, InboxMessage } from "@/lib/types";
import { PRIORITY_COLOR } from "./channels";

export default function ApprovalCard({
  result,
  message,
  canSend,
}: {
  result: AgentResult;
  message: InboxMessage;
  canSend: boolean;
}) {
  const rec = result.recommendation;
  const [text, setText] = useState(result.draft?.text ?? "");
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "rejected" | "error"
  >("idle");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    setText(result.draft?.text ?? "");
    setStatus("idle");
    setDetail("");
  }, [result]);

  async function approve() {
    setStatus("sending");
    const recipient =
      message.sender.email ?? message.sender.handle ?? undefined;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message_id: result.message_id,
        channel: message.channel,
        text,
        to: recipient?.replace(/^\+/, ""),
        thread_id: message.thread_id,
        asana_op: rec.asana_op,
      }),
    });
    if (res.ok) {
      const j = await res.json();
      setStatus("sent");
      setDetail(
        `Sent · answered in ${
          j.response_seconds ? Math.round(j.response_seconds / 60) + "m" : "—"
        }${j.asana ? ` · Asana: ${j.asana}` : ""}`
      );
    } else {
      setStatus("error");
      const j = await res.json().catch(() => ({}));
      setDetail(j.detail ?? `send failed (${res.status})`);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span
          className="chip"
          style={{ color: "var(--color-good)", borderColor: "var(--color-good)" }}
        >
          {rec.action}
        </span>
        {rec.asana_op !== "NONE" && <span className="chip">Asana: {rec.asana_op}</span>}
        <span className="chip" style={{ color: PRIORITY_COLOR[rec.priority] }}>
          {rec.priority}
        </span>
        {rec.target && <span className="chip">→ {rec.target}</span>}
        {result.delegation && (
          <span className="chip" style={{ color: "var(--color-x)" }}>
            A2A: {result.delegation.role} ({result.delegation.status})
          </span>
        )}
      </div>

      {rec.rationale && (
        <p className="text-sm text-[var(--color-muted)] mb-3">{rec.rationale}</p>
      )}

      {result.delegation?.response && (
        <div className="text-sm mb-3 rounded-lg bg-[var(--color-panel-2)] p-2 border border-[var(--color-border)]">
          {result.delegation.response}
        </div>
      )}

      {result.draft ? (
        <>
          <label className="text-xs text-[var(--color-muted)]">
            Draft reply (in your voice — edit before sending)
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!canSend || status === "sent"}
            rows={5}
            className="mt-1 w-full rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] resize-y"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={approve}
              disabled={!canSend || status === "sending" || status === "sent"}
              className="btn btn-primary"
              title={canSend ? "" : "Read-only role — sign in as owner to send"}
            >
              {status === "sending"
                ? "Sending…"
                : status === "sent"
                ? "Sent ✓"
                : "Approve & send"}
            </button>
            <button
              onClick={() => setStatus("rejected")}
              disabled={!canSend || status === "sent"}
              className="btn btn-ghost"
            >
              Reject
            </button>
            {!canSend && (
              <span className="text-xs text-[var(--color-muted)]">
                Read-only — sign in as owner to approve.
              </span>
            )}
            {detail && (
              <span
                className="text-xs ml-auto"
                style={{
                  color:
                    status === "error"
                      ? "var(--color-bad)"
                      : "var(--color-good)",
                }}
              >
                {detail}
              </span>
            )}
            {status === "rejected" && (
              <span className="text-xs ml-auto text-[var(--color-muted)]">
                Rejected — nothing sent.
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">
          No draft for this action. {result.executed_ops.join(", ")}
        </p>
      )}
    </div>
  );
}

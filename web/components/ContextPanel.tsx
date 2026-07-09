"use client";

import type { ContextPack } from "@/lib/types";
import { channelMeta } from "./channels";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">
          {title}
        </span>
        {count !== undefined && <span className="chip">{count}</span>}
      </div>
      {children}
    </div>
  );
}

export default function ContextPanel({
  context,
  loading,
}: {
  context: ContextPack | null;
  loading: boolean;
}) {
  if (loading)
    return (
      <div className="p-4 text-sm text-[var(--color-muted)]">Loading context…</div>
    );
  if (!context)
    return (
      <div className="p-4 text-sm text-[var(--color-muted)]">
        Context (Gmail · X · WhatsApp · Asana) appears here.
      </div>
    );

  return (
    <div className="scroll flex-1 p-3">
      <Section title="Hard facts" count={context.facts.length}>
        <ul className="space-y-1">
          {context.facts.map((f, i) => (
            <li key={i} className="text-sm flex gap-1.5">
              <span className="text-[var(--color-good)]">•</span>
              <span className="break-words">{f}</span>
            </li>
          ))}
          {!context.facts.length && (
            <li className="text-sm text-[var(--color-muted)]">none</li>
          )}
        </ul>
      </Section>

      <Section title="Cross-channel" count={context.cross_channel.length}>
        {context.cross_channel.map((m, i) => {
          const meta = channelMeta(m.channel);
          return (
            <div key={i} className="card p-2 mb-1.5">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span style={{ color: meta.color }}>{meta.glyph}</span>
                <span className="text-xs font-medium">{meta.label}</span>
                <span className="text-xs text-[var(--color-muted)] ml-auto">
                  {m.sender.name}
                </span>
              </div>
              <div className="text-xs text-[var(--color-muted)] break-words">
                {m.body.slice(0, 120)}
              </div>
            </div>
          );
        })}
        {!context.cross_channel.length && (
          <div className="text-sm text-[var(--color-muted)]">none</div>
        )}
      </Section>

      <Section title="Related Asana" count={context.related_tasks.length}>
        {context.related_tasks.map((t) => (
          <div key={t.gid} className="card p-2 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span style={{ color: "var(--color-asana)" }}>
                {t.is_milestone ? "◆" : "◇"}
              </span>
              <span className="text-sm font-medium break-words">{t.name}</span>
            </div>
            <div className="text-xs text-[var(--color-muted)] mt-0.5 flex gap-2 flex-wrap">
              {t.is_milestone && <span>milestone</span>}
              {t.due_on && <span>due {t.due_on}</span>}
              {t.assignee && <span>@ {t.assignee}</span>}
              {t.completed && (
                <span style={{ color: "var(--color-good)" }}>done</span>
              )}
            </div>
          </div>
        ))}
        {!context.related_tasks.length && (
          <div className="text-sm text-[var(--color-muted)]">none</div>
        )}
      </Section>

      {context.preferences.length > 0 && (
        <Section title="Preferences" count={context.preferences.length}>
          <ul className="space-y-1">
            {context.preferences.map((p, i) => (
              <li key={i} className="text-sm text-[var(--color-muted)]">
                • {p}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {context.org_facts.length > 0 && (
        <Section title="Org knowledge" count={context.org_facts.length}>
          <ul className="space-y-1">
            {context.org_facts.map((o, i) => (
              <li key={i} className="text-sm text-[var(--color-muted)]">
                • {o}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

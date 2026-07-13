"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Workspace { gid: string; name: string }
interface Project { gid: string; name: string; color?: string | null }
interface TaskSummary {
  gid: string;
  name: string;
  completed: boolean;
  due_on?: string | null;
  assignee?: { name: string } | null;
  projects?: { gid: string; name: string }[];
  modified_at?: string;
  num_subtasks?: number;
}
interface TaskDetail {
  gid: string;
  name: string;
  notes?: string;
  completed: boolean;
  due_on?: string | null;
  created_at?: string;
  modified_at?: string;
  assignee?: { name: string } | null;
  followers?: { name: string }[];
  projects?: { name: string }[];
  tags?: { name: string }[];
  permalink_url?: string;
}
interface Subtask {
  gid: string;
  name: string;
  completed: boolean;
  assignee?: { name: string } | null;
  due_on?: string | null;
}
interface Comment {
  gid: string;
  text?: string;
  created_at?: string;
  created_by?: { name: string } | null;
}

function dueLabel(due?: string | null): { text: string; overdue: boolean } | null {
  if (!due) return null;
  const date = new Date(due + "T23:59:59");
  return {
    text: new Date(due).toLocaleDateString([], { month: "short", day: "numeric" }),
    overdue: date < new Date(),
  };
}

export default function AsanaView() {
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<string>("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<string>("mine"); // "mine" | project gid
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [selected, setSelected] = useState<{
    task: TaskDetail;
    subtasks: Subtask[];
    comments: Comment[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadOverview = useCallback(async (ws?: string) => {
    const res = await fetch(`/api/asana/overview${ws ? `?workspace=${ws}` : ""}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400) setNotConnected(true);
      else setError(data.error ?? "Failed to load Asana overview");
      return;
    }
    setNotConnected(false);
    setWorkspaces(data.workspaces ?? []);
    setWorkspace(data.workspace ?? "");
    setProjects(data.projects ?? []);
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!workspace) return;
    setTasksLoading(true);
    setSelected(null);
    const qs =
      view === "mine" ? `workspace=${workspace}` : `project=${view}`;
    fetch(`/api/asana/tasks?${qs}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setTasks(data.tasks ?? []);
          setError(null);
        } else setError(data.error ?? "Failed to load tasks");
      })
      .finally(() => setTasksLoading(false));
  }, [workspace, view]);

  const openTask = async (gid: string) => {
    setDetailLoading(true);
    const res = await fetch(`/api/asana/tasks/${gid}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok) setSelected(data);
    else setError(data.error ?? "Failed to load task");
    setDetailLoading(false);
  };

  if (notConnected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="text-4xl">✅</span>
        <p className="text-sm text-neutral-300">Asana isn’t connected yet.</p>
        <Link
          href="/connections"
          className="rounded-md bg-white px-4 py-2 text-xs font-medium text-neutral-900 hover:bg-neutral-200"
        >
          Connect Asana with a Personal Access Token
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3">
        {workspaces.length > 1 && (
          <select
            value={workspace}
            onChange={(e) => {
              setView("mine");
              loadOverview(e.target.value);
            }}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            {workspaces.map((w) => (
              <option key={w.gid} value={w.gid}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setView("mine")}
            className={`rounded-full px-3 py-1 text-xs transition ${
              view === "mine"
                ? "bg-white text-neutral-900"
                : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            My tasks
          </button>
          {projects.map((p) => (
            <button
              key={p.gid}
              onClick={() => setView(p.gid)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                view === p.gid
                  ? "bg-white text-neutral-900"
                  : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-800 bg-red-950/60 px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="mt-4 flex min-h-0 flex-1 gap-4">
        {/* Task list */}
        <div className="w-2/5 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900">
          {tasksLoading ? (
            <p className="p-4 text-sm text-neutral-500">Loading tasks…</p>
          ) : tasks.length === 0 ? (
            <p className="p-4 text-sm text-neutral-500">No open tasks here.</p>
          ) : (
            tasks.map((t) => {
              const due = dueLabel(t.due_on);
              return (
                <button
                  key={t.gid}
                  onClick={() => openTask(t.gid)}
                  className={`block w-full border-b border-neutral-800 px-4 py-3 text-left transition hover:bg-neutral-800 ${
                    selected?.task.gid === t.gid ? "bg-neutral-800" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {t.completed ? "✅ " : "⬜ "}
                      {t.name || "(untitled)"}
                    </span>
                    {due && (
                      <span
                        className={`shrink-0 text-xs ${
                          due.overdue ? "text-red-400" : "text-neutral-500"
                        }`}
                      >
                        {due.text}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                    {t.assignee?.name && <span>👤 {t.assignee.name}</span>}
                    {(t.projects ?? []).slice(0, 2).map((p) => (
                      <span key={p.gid} className="rounded bg-neutral-800 px-1.5 py-0.5">
                        {p.name}
                      </span>
                    ))}
                    {t.num_subtasks ? <span>☑ {t.num_subtasks}</span> : null}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Task detail */}
        <div className="flex-1 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900">
          {detailLoading ? (
            <p className="p-4 text-sm text-neutral-500">Loading task…</p>
          ) : !selected ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              Select a task to see details
            </div>
          ) : (
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold">
                  {selected.task.completed ? "✅ " : ""}
                  {selected.task.name}
                </h2>
                {selected.task.permalink_url && (
                  <a
                    href={selected.task.permalink_url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-blue-400 hover:underline"
                  >
                    Open in Asana ↗
                  </a>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <div>
                  <dt className="text-neutral-500">Assignee</dt>
                  <dd className="text-neutral-200">
                    {selected.task.assignee?.name ?? "Unassigned"}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Due</dt>
                  <dd className="text-neutral-200">{selected.task.due_on ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Projects</dt>
                  <dd className="text-neutral-200">
                    {(selected.task.projects ?? []).map((p) => p.name).join(", ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Followers</dt>
                  <dd className="text-neutral-200">
                    {(selected.task.followers ?? []).map((f) => f.name).join(", ") || "—"}
                  </dd>
                </div>
              </dl>

              {selected.task.notes && (
                <div className="mt-4 whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-300">
                  {selected.task.notes}
                </div>
              )}

              {selected.subtasks.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-xs font-semibold uppercase text-neutral-500">
                    Subtasks
                  </h3>
                  <ul className="mt-2 flex flex-col gap-1">
                    {selected.subtasks.map((s) => (
                      <li key={s.gid} className="flex items-center gap-2 text-sm">
                        <span>{s.completed ? "✅" : "⬜"}</span>
                        <span className={s.completed ? "text-neutral-500 line-through" : ""}>
                          {s.name}
                        </span>
                        {s.assignee?.name && (
                          <span className="text-xs text-neutral-500">· {s.assignee.name}</span>
                        )}
                        {s.due_on && (
                          <span className="text-xs text-neutral-500">· due {s.due_on}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.comments.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-xs font-semibold uppercase text-neutral-500">
                    Comments
                  </h3>
                  <div className="mt-2 flex flex-col gap-2">
                    {selected.comments.map((c) => (
                      <div
                        key={c.gid}
                        className="rounded-lg border border-neutral-800 bg-neutral-950 p-3"
                      >
                        <div className="flex items-center justify-between text-xs text-neutral-500">
                          <span className="font-medium text-neutral-300">
                            {c.created_by?.name ?? "Unknown"}
                          </span>
                          <span>
                            {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-300">
                          {c.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

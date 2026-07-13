import type { Agent } from "@prisma/client";
import { asanaGet, asanaPost } from "@/lib/asana";

/**
 * Agent skills bridge incoming communications to Asana:
 *  - asana_status_report: "how is project X going?" → pull live project data
 *    (tasks, milestones, progress, due dates) and ground the reply in it.
 *  - asana_create_task: "please add ..." → propose an Asana task, created on
 *    approval (HITL) or immediately (autopilot).
 */

export interface AsanaTaskProposal {
  taskName: string;
  taskNotes: string;
  projectGid: string | null;
  projectName: string | null;
  workspaceGid: string;
}

export type SkillResult =
  | { kind: "status_context"; context: string; projectName: string | null }
  | { kind: "create_task"; proposal: AsanaTaskProposal; context: string }
  | { kind: "none" };

interface AsanaProject {
  gid: string;
  name: string;
}

interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  resource_subtype?: string;
  assignee?: { name?: string } | null;
}

const STATUS_RE =
  /\b(status|update|progress|how('s| is| are)? .{0,40}(going|coming|looking|tracking)|where (are we|do we stand)|any news)\b/i;
const CREATE_RE =
  /\b(add|create|include|put in|new task|to-?do|can you (add|create)|please (add|create)|don'?t forget to)\b/i;

export function detectIntent(text: string): "status" | "create" | null {
  if (CREATE_RE.test(text)) return "create";
  if (STATUS_RE.test(text)) return "status";
  return null;
}

/**
 * Entry point used by the runtime. Returns Asana-grounded context and/or a
 * task proposal, or { kind: "none" } when no skill applies.
 */
export async function runSkills(agent: Agent, messageText: string): Promise<SkillResult> {
  if (!agent.skills?.length || !messageText.trim()) return { kind: "none" };

  const intent = detectIntent(messageText);
  if (!intent) return { kind: "none" };

  if (intent === "status" && agent.skills.includes("asana_status_report")) {
    return buildStatusContext(agent.userId, messageText);
  }
  if (intent === "create" && agent.skills.includes("asana_create_task")) {
    return buildTaskProposal(agent.userId, messageText);
  }
  return { kind: "none" };
}

async function getWorkspaceAndProjects(
  userId: string
): Promise<{ workspaceGid: string; projects: AsanaProject[] } | null> {
  const workspaces = await asanaGet<AsanaProject[]>(userId, "/workspaces?limit=10");
  const workspaceGid = workspaces[0]?.gid;
  if (!workspaceGid) return null;
  const projects = await asanaGet<AsanaProject[]>(
    userId,
    `/projects?workspace=${workspaceGid}&archived=false&limit=100&opt_fields=name`
  );
  return { workspaceGid, projects };
}

/** Find the project whose name is mentioned in (or best overlaps) the message. */
export function matchProject(text: string, projects: AsanaProject[]): AsanaProject | null {
  const lower = text.toLowerCase();
  const exact = projects.find((p) => p.name.trim() && lower.includes(p.name.trim().toLowerCase()));
  if (exact) return exact;

  // fall back to word overlap (ignoring short/common words)
  const words = new Set(lower.split(/\W+/).filter((w) => w.length > 3));
  let best: AsanaProject | null = null;
  let bestScore = 0;
  for (const p of projects) {
    const pWords = p.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (!pWords.length) continue;
    const hits = pWords.filter((w) => words.has(w)).length;
    const score = hits / pWords.length;
    if (hits > 0 && score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

async function buildStatusContext(userId: string, text: string): Promise<SkillResult> {
  const ws = await getWorkspaceAndProjects(userId);
  if (!ws) return { kind: "none" };

  const project = matchProject(text, ws.projects);
  if (!project) {
    return {
      kind: "status_context",
      projectName: null,
      context:
        "No Asana project matching the request was found. Available projects: " +
        ws.projects.slice(0, 15).map((p) => p.name).join(", "),
    };
  }

  const tasks = await asanaGet<AsanaTask[]>(
    userId,
    `/projects/${project.gid}/tasks?limit=100&opt_fields=name,completed,completed_at,due_on,resource_subtype,assignee.name`
  );

  const today = new Date().toISOString().slice(0, 10);
  const open = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed);
  const overdue = open.filter((t) => t.due_on && t.due_on < today);
  const upcoming = open
    .filter((t) => t.due_on && t.due_on >= today)
    .sort((a, b) => (a.due_on! < b.due_on! ? -1 : 1))
    .slice(0, 5);
  const milestones = tasks.filter((t) => t.resource_subtype === "milestone");
  const recentlyDone = done
    .filter((t) => t.completed_at)
    .sort((a, b) => (a.completed_at! > b.completed_at! ? -1 : 1))
    .slice(0, 5);
  const pct = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;

  const lines = [
    `Asana project: "${project.name}"`,
    `Progress: ${done.length}/${tasks.length} tasks completed (${pct}%). ${open.length} open, ${overdue.length} overdue.`,
  ];
  if (milestones.length) {
    lines.push(
      "Milestones: " +
        milestones
          .map((m) => `${m.name} — ${m.completed ? "reached" : m.due_on ? `due ${m.due_on}` : "in progress"}`)
          .join("; ")
    );
  }
  if (recentlyDone.length) {
    lines.push("Recently completed: " + recentlyDone.map((t) => t.name).join("; "));
  }
  if (upcoming.length) {
    lines.push(
      "Coming up: " +
        upcoming
          .map((t) => `${t.name} (due ${t.due_on}${t.assignee?.name ? `, ${t.assignee.name}` : ""})`)
          .join("; ")
    );
  }
  if (overdue.length) {
    lines.push("Overdue: " + overdue.slice(0, 5).map((t) => `${t.name} (was due ${t.due_on})`).join("; "));
  }

  return { kind: "status_context", projectName: project.name, context: lines.join("\n") };
}

/** Extract a task title from natural language like "please add X to the project". */
export function extractTaskName(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /(?:please\s+)?(?:can|could)\s+you\s+(?:add|create|include)\s+(?:a\s+task\s+(?:for|to)\s+)?(.+?)(?:[.?!\n]|$)/i,
    /(?:please\s+)?(?:add|create|include)\s+(?:a\s+(?:new\s+)?task\s+(?:for|to|called|named)?\s*)?(.+?)(?:[.?!\n]|$)/i,
    /don'?t\s+forget\s+to\s+(.+?)(?:[.?!\n]|$)/i,
    /put\s+in\s+(.+?)(?:[.?!\n]|$)/i,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m?.[1]) {
      let name = m[1].trim();
      // drop trailing project references — they're used for matching, not the title
      name = name.replace(/\s+(?:to|in|on|for)\s+(?:the\s+)?(?:.*\b(?:project|board)\b.*)$/i, "").trim();
      if (name.length >= 3) return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return null;
}

async function buildTaskProposal(userId: string, text: string): Promise<SkillResult> {
  const ws = await getWorkspaceAndProjects(userId);
  if (!ws) return { kind: "none" };

  const taskName = extractTaskName(text);
  if (!taskName) return { kind: "none" };

  const project = matchProject(text, ws.projects);
  const proposal: AsanaTaskProposal = {
    taskName,
    taskNotes: `Requested via incoming message:\n\n"${text.trim().slice(0, 1000)}"`,
    projectGid: project?.gid ?? null,
    projectName: project?.name ?? null,
    workspaceGid: ws.workspaceGid,
  };

  const context = project
    ? `An Asana task "${taskName}" will be created in project "${project.name}" once approved. Confirm this to the sender.`
    : `An Asana task "${taskName}" will be created in the workspace (no specific project matched) once approved. Confirm this to the sender.`;

  return { kind: "create_task", proposal, context };
}

/** Actually create the proposed task in Asana. Returns the new task gid. */
export async function executeCreateTask(
  userId: string,
  proposal: AsanaTaskProposal
): Promise<string> {
  const body: Record<string, unknown> = {
    name: proposal.taskName,
    notes: proposal.taskNotes,
  };
  if (proposal.projectGid) body.projects = [proposal.projectGid];
  else body.workspace = proposal.workspaceGid;

  const task = await asanaPost<{ gid: string }>(userId, "/tasks", body);
  return task.gid;
}

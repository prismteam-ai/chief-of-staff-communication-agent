// Mirrors of the Python API payloads (cos/models.py, cos/kb/ontology.py, brain.stream).

export type Channel = "gmail" | "x" | "whatsapp";

export interface InboxMessage {
  id: string;
  channel: Channel;
  thread_id: string;
  sender: { name: string; handle: string | null; email: string | null };
  subject: string | null;
  snippet: string;
  timestamp: string;
  awaiting: boolean;
  overdue: boolean;
}

export interface Task {
  gid: string;
  name: string;
  notes: string;
  due_on: string | null;
  completed: boolean;
  is_milestone: boolean;
  assignee: string | null;
  permalink_url: string | null;
}

export interface Message {
  id: string;
  channel: Channel;
  thread_id: string;
  sender: { name: string; handle: string | null; email: string | null };
  subject: string | null;
  body: string;
  timestamp: string;
}

export interface ContextPack {
  message: Message;
  facts: string[];
  thread_history: Message[];
  sender_history: Message[];
  related_tasks: Task[];
  cross_channel: Message[];
  style_examples: string[];
  preferences: string[];
  org_facts: string[];
}

export interface Recommendation {
  message_id: string;
  action: string;
  asana_op: string;
  priority: string;
  confidence: number;
  rationale: string;
  target: string | null;
}

export interface Draft {
  message_id: string;
  text: string;
  in_style_of: string;
}

export interface Delegation {
  role: string;
  summary: string;
  reason: string;
  status: string;
  response: string | null;
}

export interface AgentResult {
  message_id: string;
  recommendation: Recommendation;
  draft: Draft | null;
  delegation: Delegation | null;
  executed_ops: string[];
  facts_used: string[];
  trace: string[];
}

// SSE event union from brain.stream()
export type AgentEvent =
  | { type: "tool_call"; name: string; result: unknown }
  | { type: "context"; context: ContextPack }
  | { type: "thought"; step: string; text: string; triage?: unknown }
  | { type: "action"; step: string; text: string; recommendation: Recommendation }
  | { type: "draft"; step: string; text: string; draft: Draft }
  | { type: "result"; result: AgentResult }
  | { type: "error"; message: string };

export interface ConnectionStatus {
  provider: Channel | "asana";
  mode: "mock" | "real";
  connected: boolean;
  detail: string;
}

export interface ConnectionsResponse {
  mode: string;
  providers: ConnectionStatus[];
}

// --- Style (owner-authored voice/rules/examples + the learned profile) --------
export interface StyleOverrides {
  voice: string;
  signoff: string;
  rules: string[];
  examples: string[];
}

export interface StyleProfile {
  tone: string;
  formality: string;
  signoff: string;
  uses_emoji: boolean;
  avg_sentence_words: number;
  rules: string[];
  examples: string[];
}

export interface StyleResponse {
  overrides: StyleOverrides;
  profile: StyleProfile | null;
  editable: boolean;
}

// --- Dashboard metrics --------------------------------------------------------
export interface Metrics {
  total: number;
  by_channel: Record<string, number>;
  awaiting: number;
  overdue: number;
  answered: number;
  pending_approvals: number;
  median_response_seconds: number | null;
}

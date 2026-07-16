import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

/**
 * Asana REST client (Task 7, design.md §9): the ONE shared implementation the `manageAsana` agent
 * tool and the `apps/api` tRPC procedures both use — no duplicated fetch/retry/auth code.
 *
 * ## Scoping (privacy, non-negotiable — Task 7 brief)
 * The PAT in `cos/asana` grants access to the whole Asana workspace, but this client confines EVERY
 * write and the sync read to exactly one project: `project_gid` from the secret ("CoS Communication
 * Agent"). `createTask` always includes `projects: [project_gid]`; `listCommunicationAgentTasks`
 * queries `GET /projects/{project_gid}/tasks` and NEVER a workspace-wide endpoint. There is no
 * method on this client that can read or write outside that one project.
 *
 * ## Secret shape and caching
 * `cos/asana` = `{ pat, workspace_gid, project_gid }` (Secrets Manager). Cached the same way
 * `packages/connectors/src/gmail/gmail-client.ts` caches `cos/gmail-oauth-client` — a module-level
 * memo with a bounded TTL, so a warm Lambda container does not re-fetch the secret on every call, but
 * a rotated secret is picked up within one TTL window without a redeploy.
 *
 * ## Retry / timeout / rate-limit
 * Every request goes through `requestJson`: an AbortController-backed timeout, and exponential
 * backoff on HTTP 429 (honoring `Retry-After` when present) and on 5xx, up to `maxRetries`. Non-429/
 * 5xx failures (4xx other than 429) are NOT retried — they are caller errors (bad gid, bad payload)
 * that a retry cannot fix.
 *
 * The PAT is NEVER logged — every thrown error message is built from the endpoint path and HTTP
 * status only, never headers or body (which could echo the Authorization header back).
 */

export const ASANA_SECRET_ID = 'cos/asana';
export const ASANA_API_BASE_URL = 'https://app.asana.com/api/1.0';

const SECRET_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_BACKOFF_MS = 250;

export const AsanaSecretSchema = z.object({
  pat: z.string().min(1),
  workspace_gid: z.string().min(1),
  project_gid: z.string().min(1),
});
export type AsanaSecret = z.infer<typeof AsanaSecretSchema>;

let cachedSecretsClient: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  cachedSecretsClient ??= new SecretsManagerClient({});
  return cachedSecretsClient;
}

interface CachedSecret {
  value: AsanaSecret;
  fetchedAt: number;
}
let cachedAsanaSecret: CachedSecret | undefined;

/** Test-only reset for the module-level secret cache — mirrors no gmail-client export (there is no
 * equivalent there) but is needed here because tests assert on cache TTL behavior in isolation. */
export function resetAsanaSecretCacheForTests(): void {
  cachedAsanaSecret = undefined;
}

export async function loadAsanaSecret(
  maxAgeMs: number = SECRET_CACHE_MAX_AGE_MS,
): Promise<AsanaSecret> {
  if (cachedAsanaSecret && Date.now() - cachedAsanaSecret.fetchedAt < maxAgeMs) {
    return cachedAsanaSecret.value;
  }

  const result = await secretsClient().send(
    new GetSecretValueCommand({ SecretId: ASANA_SECRET_ID }),
  );
  if (!result.SecretString) {
    throw new Error(`Secret ${ASANA_SECRET_ID} has no SecretString value`);
  }
  const parsed = AsanaSecretSchema.parse(JSON.parse(result.SecretString));
  cachedAsanaSecret = { value: parsed, fetchedAt: Date.now() };
  return parsed;
}

// --- Asana resource shapes (only the fields this client actually uses) ------------------------

export const AsanaTaskSchema = z.object({
  gid: z.string(),
  name: z.string(),
  notes: z.string().optional().default(''),
  completed: z.boolean().optional().default(false),
  permalink_url: z.string().optional(),
  due_on: z.string().nullable().optional(),
  projects: z.array(z.object({ gid: z.string(), name: z.string().optional() })).optional(),
});
export type AsanaTask = z.infer<typeof AsanaTaskSchema>;

export const AsanaProjectSchema = z.object({
  gid: z.string(),
  name: z.string(),
});
export type AsanaProject = z.infer<typeof AsanaProjectSchema>;

export const AsanaStorySchema = z.object({
  gid: z.string(),
  text: z.string().optional(),
});
export type AsanaStory = z.infer<typeof AsanaStorySchema>;

export interface CreateAsanaTaskInput {
  name: string;
  notes?: string;
  dueOn?: string;
}

export interface UpdateAsanaTaskInput {
  name?: string;
  notes?: string;
  dueOn?: string | null;
  completed?: boolean;
}

/** Back-reference + provenance note appended to a task's notes on create/link (Task 7 brief
 * constraint 3/5: "task notes carry comm context + provenance"). Sender/subject only — never a
 * full body. */
export interface CommunicationProvenance {
  commId: string;
  channel: string;
  threadKey: string;
  ts: string;
  senderName?: string;
  subject?: string;
}

export function formatProvenanceNote(provenance: CommunicationProvenance): string {
  const lines = [
    '--- Chief of Staff Communication Agent ---',
    `commId: ${provenance.commId}`,
    `channel: ${provenance.channel}`,
    `thread: ${provenance.threadKey}`,
    `timestamp: ${provenance.ts}`,
  ];
  if (provenance.senderName) lines.push(`from: ${provenance.senderName}`);
  if (provenance.subject) lines.push(`subject: ${provenance.subject}`);
  return lines.join('\n');
}

// --- HTTP layer: timeout + retry/backoff --------------------------------------------------------

export class AsanaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
  ) {
    super(`Asana API request to "${path}" failed with status ${status}`);
    this.name = 'AsanaApiError';
  }
}

export interface AsanaClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  /** Injectable sleep so retry-backoff tests never actually wait — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable secret loader, defaulting to `loadAsanaSecret` — lets tests skip Secrets Manager. */
  loadSecret?: () => Promise<AsanaSecret>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The Asana client. Every read/write funnels through `requestJson`, which owns the timeout and the
 * 429/5xx backoff — no caller hand-rolls its own retry loop.
 */
export class AsanaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly loadSecret: () => Promise<AsanaSecret>;

  constructor(options: AsanaClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.loadSecret = options.loadSecret ?? (() => loadAsanaSecret());
  }

  /** The project this client is scoped to (Task 7 brief: "ALL Asana activity confined to
   * project_gid"). Exposed so callers (e.g. `createTask`'s implicit default) never need to re-fetch
   * the secret just to know which project to write into. */
  async projectGid(): Promise<string> {
    const secret = await this.loadSecret();
    return secret.project_gid;
  }

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    // `z.ZodType<T, z.ZodTypeDef, any>` deliberately loosens the schema's INPUT type — schemas like
    // `AsanaTaskSchema` use `.default()` on `notes`/`completed`, so their input type has optional
    // fields while their output type (`T`, what `.parse` returns) does not. Pinning only the output
    // type here lets every call site pass its schema without a redundant cast.
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    const secret = await this.loadSecret();
    const url = `${ASANA_API_BASE_URL}${path}`;

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${secret.pat}`,
            'Content-Type': 'application/json',
          },
          body: body !== undefined ? JSON.stringify({ data: body }) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          throw new Error(`Asana API request to "${path}" timed out after ${this.timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      }
      clearTimeout(timeout);

      if (response.ok) {
        const json = (await response.json()) as { data: unknown };
        return schema.parse(json.data);
      }

      if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
        const backoffMs =
          retryAfterMs && Number.isFinite(retryAfterMs)
            ? retryAfterMs
            : this.baseBackoffMs * 2 ** attempt;
        attempt += 1;
        await this.sleep(backoffMs);
        continue;
      }

      throw new AsanaApiError(response.status, path);
    }
  }

  /** Creates a task ALWAYS in the client's scoped project (Task 7 brief constraint 3: "Created
   * tasks -> projects:[project_gid] on create"). `projects` is never accepted as caller input. */
  async createTask(input: CreateAsanaTaskInput): Promise<AsanaTask> {
    const projectGid = await this.projectGid();
    return this.requestJson('POST', '/tasks', AsanaTaskSchema, {
      name: input.name,
      notes: input.notes ?? '',
      due_on: input.dueOn,
      projects: [projectGid],
    });
  }

  async updateTask(taskGid: string, input: UpdateAsanaTaskInput): Promise<AsanaTask> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.notes !== undefined) body.notes = input.notes;
    if (input.dueOn !== undefined) body.due_on = input.dueOn;
    if (input.completed !== undefined) body.completed = input.completed;
    return this.requestJson('PUT', `/tasks/${taskGid}`, AsanaTaskSchema, body);
  }

  async addComment(taskGid: string, text: string): Promise<AsanaStory> {
    return this.requestJson('POST', `/tasks/${taskGid}/stories`, AsanaStorySchema, { text });
  }

  async getTask(taskGid: string): Promise<AsanaTask> {
    return this.requestJson('GET', `/tasks/${taskGid}?opt_fields=name,notes,completed,permalink_url,due_on,projects.name`, AsanaTaskSchema);
  }

  /** Lists tasks ONLY within the client's scoped project (Task 7 brief constraint: "RAG asana-sync
   * -> GET /projects/{project_gid}/tasks ONLY, never the whole workspace"). */
  async listCommunicationAgentTasks(): Promise<AsanaTask[]> {
    const projectGid = await this.projectGid();
    return this.requestJson(
      'GET',
      `/projects/${projectGid}/tasks?opt_fields=name,notes,completed,permalink_url,due_on,projects.name`,
      z.array(AsanaTaskSchema),
    );
  }

  /** Read-only listing of the workspace's projects (used by the `listAsanaProjects` tRPC procedure
   * for UI/setup purposes) — a read, never a write target; writes always go through `createTask`'s
   * fixed `project_gid`. */
  async listProjects(): Promise<AsanaProject[]> {
    const secret = await this.loadSecret();
    return this.requestJson(
      'GET',
      `/workspaces/${secret.workspace_gid}/projects?opt_fields=name`,
      z.array(AsanaProjectSchema),
    );
  }

  /**
   * Links a communication to an existing Asana task: appends a provenance/back-reference comment
   * to the task (Task 7 brief constraint 3: "back-reference note in the task") so the Asana side is
   * self-explanatory about which communication it originated from. Returns the resulting task (for
   * the caller to persist `permalink_url`/`gid` on the communication record).
   */
  async linkToCommunication(
    taskGid: string,
    provenance: CommunicationProvenance,
  ): Promise<AsanaTask> {
    await this.addComment(taskGid, formatProvenanceNote(provenance));
    return this.getTask(taskGid);
  }
}

import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { AccountOwnershipMap } from '@chief-of-staff/shared';
import { assertAccountAccess } from '@chief-of-staff/shared';
import type { AsanaClient, AsanaTask } from '@chief-of-staff/connectors/asana';
import { formatProvenanceNote, ScopeViolationError } from '@chief-of-staff/connectors/asana';
import type { logger as LoggerType, metrics as MetricsType } from '../context.js';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';

/**
 * The human-approved Asana write surface (Task 7, design.md §9, brief constraint 3: "Execution via
 * human-approved tRPC (apps/api)"). This is the ONLY place in the system that actually calls
 * `AsanaClient.createTask`/`updateTask`/`linkToCommunication` — the agent's `manageAsana` tool
 * (`apps/agent-handler/src/tools/manage-asana.ts`) only ever PROPOSES (see that module's doc
 * comment: it has no network dependency at all). A human clicking "approve" in the dashboard, or an
 * operator calling this procedure directly, is what turns a suggestion into a real Asana write.
 *
 * Framework-free, same separation as `ApprovalService` — `routers/asana.ts` is a thin tRPC adapter
 * over this class. Every procedure loads the communication and asserts `userId` owns its account
 * BEFORE touching Asana (`loadAuthorized`/`assertAccountOwned`, the same guard shape
 * `ApprovalService` uses) — account-scoped access is enforced server-side on every path, per
 * design.md §10.
 */

export class CommunicationNotFoundError extends Error {
  constructor(public readonly commId: string) {
    super(`Communication "${commId}" not found`);
    this.name = 'CommunicationNotFoundError';
  }
}

export interface AsanaServiceDeps {
  asanaClient: AsanaClient;
  communicationsRepo: CommunicationsRepo;
  accountsRepo: AccountsRepo;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  /** Injectable clock for deterministic tests; defaults to the real current time. */
  now?: () => Date;
}

export interface CreateAsanaFollowupInput {
  commId: string;
  userId: string;
  title: string;
  notes?: string;
  dueOn?: string;
}

export interface LinkAsanaInput {
  commId: string;
  userId: string;
  taskGid: string;
}

function ownershipMapFor(accountId: string, ownerUserId: string | undefined): AccountOwnershipMap {
  return ownerUserId ? { [accountId]: ownerUserId } : {};
}

export class AsanaService {
  private readonly asanaClient: AsanaClient;
  private readonly communicationsRepo: CommunicationsRepo;
  private readonly accountsRepo: AccountsRepo;
  private readonly log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  private readonly metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  private readonly now: () => Date;

  constructor(deps: AsanaServiceDeps) {
    this.asanaClient = deps.asanaClient;
    this.communicationsRepo = deps.communicationsRepo;
    this.accountsRepo = deps.accountsRepo;
    this.log = deps.log;
    this.metricsClient = deps.metricsClient;
    this.now = deps.now ?? (() => new Date());
  }

  /** Loads a communication and asserts `userId` owns its account — the one server-side guard
   * every Asana write path routes through (design.md §10, mirrors `ApprovalService.loadAuthorized`). */
  private async loadAuthorized(commId: string, userId: string): Promise<ApiCommunicationRecord> {
    const record = await this.communicationsRepo.getById(commId);
    if (!record) throw new CommunicationNotFoundError(commId);

    const ownerUserId = await this.accountsRepo.getOwner(record.accountId);
    assertAccountAccess(userId, record.accountId, ownershipMapFor(record.accountId, ownerUserId));

    return record;
  }

  /**
   * Creates a new Asana follow-up task from a communication (design.md §9: "create or update
   * follow-up tasks from a communication"). ALWAYS created in the client's scoped `project_gid`
   * (`AsanaClient.createTask`'s own guarantee — `projects` is never caller input, here or in the
   * client). The task notes carry communication context + provenance (channel/thread/timestamps/
   * back-ref, brief constraint 4) via `formatProvenanceNote`, appended after any human-supplied
   * notes — sender name/subject only, never the full message body (brief constraint 4).
   *
   * Belt-and-suspenders: after create, asserts the returned task's `projects` really does include
   * `project_gid` before persisting. The create path is safe by construction (`createTask` never
   * accepts a caller-supplied `projects`), so this should never fire — it exists purely to catch an
   * unexpected Asana API response, not to compensate for a gap in `createTask` itself.
   */
  async createAsanaFollowup(input: CreateAsanaFollowupInput): Promise<ApiCommunicationRecord> {
    const record = await this.loadAuthorized(input.commId, input.userId);

    const provenanceNote = formatProvenanceNote({
      commId: record.commId,
      channel: record.channelType,
      threadKey: record.threadKey,
      ts: record.ts,
      senderName: record.participants.find((p) => p.role === 'from')?.displayName,
      subject: record.subject,
    });
    const notes = input.notes ? `${input.notes}\n\n${provenanceNote}` : provenanceNote;

    let task: AsanaTask;
    try {
      task = await this.asanaClient.createTask({ name: input.title, notes, dueOn: input.dueOn });
      const projectGid = await this.asanaClient.projectGid();
      const isMember = (task.projects ?? []).some((project) => project.gid === projectGid);
      if (!isMember) {
        throw new ScopeViolationError(task.gid, projectGid);
      }
    } catch (error) {
      this.metricsClient.addMetric('AsanaApiFailed', MetricUnit.Count, 1);
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Asana createTask failed', { commId: record.commId, error: message });
      throw error;
    }

    await this.communicationsRepo.linkAsanaTask(record.commId, task.gid, task.permalink_url);
    this.metricsClient.addMetric('AsanaTaskCreated', MetricUnit.Count, 1);
    this.log.info('Asana follow-up task created', { commId: record.commId, taskGid: task.gid });

    return { ...record, asanaTaskGid: task.gid, asanaTaskPermalink: task.permalink_url };
  }

  /**
   * Links a communication to an EXISTING Asana task (design.md §9: "link communications to tasks").
   * Appends a provenance/back-reference comment to the task (`AsanaClient.linkToCommunication`) so
   * "the link is visible from both sides" (brief `Verify`): the Asana task carries a comment
   * referencing the communication, and the communication record carries the task's gid/permalink.
   *
   * `input.taskGid` is caller-supplied and could name a task in ANY of the user's Asana projects,
   * not just the configured `project_gid` (privacy scoping, non-negotiable — Task 7 brief).
   * `AsanaClient.linkToCommunication` asserts project membership before writing the comment and
   * throws `ScopeViolationError` if the task is out of scope; that error is logged distinctly (never
   * counted as an ordinary `AsanaApiFailed`) and propagated WITHOUT persisting anything on the
   * communication record — an out-of-project taskGid never reaches `linkAsanaTask`.
   *
   * Idempotent: re-linking the same commId to the same taskGid re-posts a comment (Asana has no
   * dedupe-by-content concept for stories) but always converges the communication record to the
   * same `asanaTaskGid`/`asanaTaskPermalink` — a re-run never creates a second link record, and the
   * brief's idempotency proof (`(c) re-link/re-sync no dupes`) is about the communication-side
   * state, not Asana comment count, which this satisfies by construction (a plain attribute set).
   */
  async linkAsana(input: LinkAsanaInput): Promise<ApiCommunicationRecord> {
    const record = await this.loadAuthorized(input.commId, input.userId);

    let task: AsanaTask;
    try {
      task = await this.asanaClient.linkToCommunication(input.taskGid, {
        commId: record.commId,
        channel: record.channelType,
        threadKey: record.threadKey,
        ts: record.ts,
        senderName: record.participants.find((p) => p.role === 'from')?.displayName,
        subject: record.subject,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ScopeViolationError) {
        this.metricsClient.addMetric('AsanaScopeViolationRejected', MetricUnit.Count, 1);
        this.log.warn('Asana linkAsana rejected: task is outside the configured project', {
          commId: record.commId,
          taskGid: input.taskGid,
        });
        throw error;
      }
      this.metricsClient.addMetric('AsanaApiFailed', MetricUnit.Count, 1);
      this.log.error('Asana linkToCommunication failed', {
        commId: record.commId,
        taskGid: input.taskGid,
        error: message,
      });
      throw error;
    }

    await this.communicationsRepo.linkAsanaTask(record.commId, task.gid, task.permalink_url);
    this.metricsClient.addMetric('AsanaTaskLinked', MetricUnit.Count, 1);
    this.log.info('Communication linked to Asana task', {
      commId: record.commId,
      taskGid: task.gid,
    });

    return { ...record, asanaTaskGid: task.gid, asanaTaskPermalink: task.permalink_url };
  }
}

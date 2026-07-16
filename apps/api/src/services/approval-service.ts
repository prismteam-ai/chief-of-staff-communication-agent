import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  applyTransition,
  assertAccountAccess,
  type AccountOwnershipMap,
  type ChannelType,
  type CommunicationState,
  type Draft,
  type TransitionRecord,
} from '@chief-of-staff/shared';
import type { Connector } from '@chief-of-staff/connectors';
import type { logger as LoggerType, metrics as MetricsType } from '../context.js';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';

/**
 * The approval loop's business logic (design.md §7/§8, Task 6 brief constraint 3): every
 * transition goes through `applyTransition` (never hand-rolled), every action enforces the
 * account-permission guard server-side, and the send handoff is idempotent (claim-before-send,
 * design.md §7 "not fire-and-forget"). Framework-free — the tRPC router (`routers/communications.ts`)
 * is a thin adapter over this class, same separation `run-agent-turn.ts` uses for the agent.
 */

export class CommunicationNotFoundError extends Error {
  constructor(public readonly commId: string) {
    super(`Communication "${commId}" not found`);
    this.name = 'CommunicationNotFoundError';
  }
}

/** A request is well-formed but not valid to perform on this communication right now. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

export interface ApprovalServiceDeps {
  communicationsRepo: CommunicationsRepo;
  accountsRepo: AccountsRepo;
  /** Resolves the owning connector for a channel — Gmail today; other channels return `undefined`. */
  connectorFor: (channelType: ChannelType) => Connector | undefined;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  /** Injectable clock for deterministic tests; defaults to the real current time. */
  now?: () => Date;
}

export interface ListCommunicationsInput {
  accountId: string;
  userId: string;
  status?: CommunicationState;
}

export interface ByIdAndUserInput {
  commId: string;
  userId: string;
}

export interface EditDraftInput extends ByIdAndUserInput {
  newBody: string;
}

export interface SupplyContextInput extends ByIdAndUserInput {
  text: string;
}

/** Builds the single-entry `AccountOwnershipMap` `assertAccountAccess` expects, from one lookup. */
function ownershipMapFor(accountId: string, ownerUserId: string | undefined): AccountOwnershipMap {
  return ownerUserId ? { [accountId]: ownerUserId } : {};
}

export class ApprovalService {
  private readonly communicationsRepo: CommunicationsRepo;
  private readonly accountsRepo: AccountsRepo;
  private readonly connectorFor: (channelType: ChannelType) => Connector | undefined;
  private readonly log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  private readonly metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  private readonly now: () => Date;

  constructor(deps: ApprovalServiceDeps) {
    this.communicationsRepo = deps.communicationsRepo;
    this.accountsRepo = deps.accountsRepo;
    this.connectorFor = deps.connectorFor;
    this.log = deps.log;
    this.metricsClient = deps.metricsClient;
    this.now = deps.now ?? (() => new Date());
  }

  /** Loads a communication and asserts `userId` owns its account — the one server-side guard
   * every read/write path routes through (design.md §10, brief constraint 3). */
  private async loadAuthorized(commId: string, userId: string): Promise<ApiCommunicationRecord> {
    const record = await this.communicationsRepo.getById(commId);
    if (!record) throw new CommunicationNotFoundError(commId);

    const ownerUserId = await this.accountsRepo.getOwner(record.accountId);
    assertAccountAccess(userId, record.accountId, ownershipMapFor(record.accountId, ownerUserId));

    return record;
  }

  private async assertAccountOwned(accountId: string, userId: string): Promise<void> {
    const ownerUserId = await this.accountsRepo.getOwner(accountId);
    assertAccountAccess(userId, accountId, ownershipMapFor(accountId, ownerUserId));
  }

  /** Applies one transition (via `applyTransition`) and persists it through the repo's
   * conditional write — the one place every mutating action funnels through. */
  private async move(
    record: ApiCommunicationRecord,
    to: CommunicationState,
    actorId: string,
    patch?: { draft?: Draft },
  ): Promise<TransitionRecord> {
    const transition = applyTransition({
      commId: record.commId,
      accountId: record.accountId,
      from: record.status,
      to,
      actorId,
      now: this.now,
    });
    await this.communicationsRepo.transition(transition, patch);
    return transition;
  }

  /**
   * Resolves who the reply should go to: every `to`/`cc` participant EXCLUDING the account's own
   * mailbox address, falling back to the `from` participant if that set is empty.
   *
   * Naively trusting `role === 'from'` is wrong here: some persisted communications are the
   * account's OWN sent mail replayed back through the ingest pipeline (self-thread seed data,
   * confirmed against live records — e.g. a message where `demoalex775@gmail.com` is tagged
   * `from` because Alex sent it, not received it). Blindly addressing the reply to `from` in that
   * case would send it back to the account's own mailbox instead of the actual counterpart. Using
   * "everyone except myself" is correct regardless of which role a given message happened to tag
   * the account's own address with.
   */
  private async resolveReplyRecipients(record: ApiCommunicationRecord): Promise<string[]> {
    const ownAddress = (await this.accountsRepo.getOwnAddress(record.accountId))?.toLowerCase();

    const toAndCc = record.participants.filter((p) => p.role === 'to' || p.role === 'cc');
    const notSelf = (p: { id: string }) => !ownAddress || p.id.toLowerCase() !== ownAddress;

    const recipients = toAndCc.filter(notSelf).map((p) => p.id);
    if (recipients.length > 0) return recipients;

    // Fallback: no to/cc participant survived the self-filter (e.g. a two-party thread where the
    // OTHER party happens to be tagged `from`) — reply to whichever participant is not the
    // account's own address.
    const fromParticipant = record.participants.find((p) => notSelf(p));
    return fromParticipant ? [fromParticipant.id] : [];
  }

  async listCommunications(input: ListCommunicationsInput): Promise<ApiCommunicationRecord[]> {
    await this.assertAccountOwned(input.accountId, input.userId);
    return this.communicationsRepo.listByAccount(input.accountId, input.status);
  }

  async getCommunication(input: ByIdAndUserInput): Promise<ApiCommunicationRecord> {
    return this.loadAuthorized(input.commId, input.userId);
  }

  /**
   * `drafted → [awaiting_approval →] approved → sent → answered` (design.md §7). A record already
   * sitting in `awaiting_approval` (opened for review) skips the first hop. Send is claimed via a
   * conditional write BEFORE the connector is invoked (Task 6 brief constraint 2: idempotent send,
   * "a retried approval doesn't double-send") — a second call on an already-`approved`/`sent`/
   * `answered` record fails fast on the state check, and a genuinely concurrent race is caught by
   * `claimSend`'s own conditional write (`SendAlreadyClaimedError`).
   */
  async approveDraft(input: ByIdAndUserInput): Promise<ApiCommunicationRecord> {
    let record = await this.loadAuthorized(input.commId, input.userId);

    if (record.status !== 'drafted' && record.status !== 'awaiting_approval') {
      throw new IllegalActionError(
        `Cannot approve communication "${record.commId}" in state "${record.status}" ` +
          '(must be drafted or awaiting_approval).',
      );
    }
    if (!record.draft) {
      throw new IllegalActionError(`Communication "${record.commId}" has no draft to approve.`);
    }
    // Captured before any reassignment below — `record`'s reassignments widen `draft` back to
    // optional in TS's eyes even though it is provably still present at runtime.
    const draft: Draft = record.draft;

    const connector = this.connectorFor(record.channelType);
    if (!connector?.send) {
      throw new IllegalActionError(
        `Channel "${record.channelType}" has no sendable connector — cannot approve/send.`,
      );
    }

    if (record.status === 'drafted') {
      await this.move(record, 'awaiting_approval', input.userId);
      record = { ...record, status: 'awaiting_approval' };
    }

    await this.move(record, 'approved', input.userId);
    record = { ...record, status: 'approved' };
    this.metricsClient.addMetric('DraftApproved', MetricUnit.Count, 1);

    // --- send handoff: claim BEFORE calling the connector (idempotency, brief constraint 2) ----
    await this.communicationsRepo.claimSend(record.commId);

    const replyRecipients = await this.resolveReplyRecipients(record);
    const startedAt = this.now().getTime();

    let sendResult;
    try {
      sendResult = await connector.send({
        accountId: record.accountId,
        threadKey: record.threadKey,
        inReplyToExternalId: record.externalId,
        inReplyToMessageId: record.providerMessageIdHeader,
        to: replyRecipients,
        body: draft.body,
        idempotencyKey: record.commId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Send failed after approval — record left at approved, not sent', {
        commId: record.commId,
        channelType: record.channelType,
        error: message,
      });
      this.metricsClient.addMetric('SendFailed', MetricUnit.Count, 1);
      throw error;
    } finally {
      this.metricsClient.addMetric(
        'SendDuration',
        MetricUnit.Milliseconds,
        this.now().getTime() - startedAt,
      );
    }

    await this.move(record, 'sent', input.userId);
    record = { ...record, status: 'sent' };

    // Persist the provider-confirmed id, then close the loop: sent -> answered.
    await this.communicationsRepo.recordSent(record.commId, sendResult.providerMessageId);
    record = { ...record, sentMessageId: sendResult.providerMessageId };

    await this.move(record, 'answered', input.userId);
    record = { ...record, status: 'answered' };

    this.metricsClient.addMetric('ReplySent', MetricUnit.Count, 1);
    this.log.info('Draft approved and sent', {
      commId: record.commId,
      channelType: record.channelType,
      status: record.status,
    });

    return record;
  }

  /**
   * `[drafted →] awaiting_approval → edited → awaiting_approval` (design.md §7). The two-hop
   * `edited` detour is the state machine's real edge (not a shortcut) — the audit trail records
   * the user's edit as its own transition, distinct from the original draft.
   */
  async editDraft(input: EditDraftInput): Promise<ApiCommunicationRecord> {
    let record = await this.loadAuthorized(input.commId, input.userId);
    const trimmed = input.newBody.trim();
    if (!trimmed) {
      throw new IllegalActionError('editDraft requires a non-empty newBody.');
    }
    if (record.status !== 'drafted' && record.status !== 'awaiting_approval') {
      throw new IllegalActionError(
        `Cannot edit communication "${record.commId}" in state "${record.status}".`,
      );
    }
    if (!record.draft) {
      throw new IllegalActionError(`Communication "${record.commId}" has no draft to edit.`);
    }
    const existingDraft: Draft = record.draft;

    if (record.status === 'drafted') {
      await this.move(record, 'awaiting_approval', input.userId);
      record = { ...record, status: 'awaiting_approval' };
    }

    const editedDraft: Draft = { ...existingDraft, body: trimmed };
    await this.move(record, 'edited', input.userId);
    record = { ...record, status: 'edited' };

    await this.move(record, 'awaiting_approval', input.userId, { draft: editedDraft });
    record = { ...record, status: 'awaiting_approval', draft: editedDraft };

    this.log.info('Draft edited', { commId: record.commId, status: record.status });
    return record;
  }

  /** `[drafted →] awaiting_approval → rejected → drafted` — re-draft (design.md §7). */
  async rejectDraft(input: ByIdAndUserInput): Promise<ApiCommunicationRecord> {
    let record = await this.loadAuthorized(input.commId, input.userId);
    if (record.status !== 'drafted' && record.status !== 'awaiting_approval') {
      throw new IllegalActionError(
        `Cannot reject communication "${record.commId}" in state "${record.status}".`,
      );
    }

    if (record.status === 'drafted') {
      await this.move(record, 'awaiting_approval', input.userId);
      record = { ...record, status: 'awaiting_approval' };
    }

    await this.move(record, 'rejected', input.userId);
    record = { ...record, status: 'rejected' };

    await this.move(record, 'drafted', input.userId);
    record = { ...record, status: 'drafted' };

    this.log.info('Draft rejected — back to drafted for re-draft', { commId: record.commId });
    return record;
  }

  /**
   * `recommended → dismissed` (design.md §7 primary path) or `drafted → dismissed` (Task 6
   * addition — see `state-machine.ts` doc comment: a human dismissing an already-drafted
   * communication that turns out not to need a reply, e.g. `fyi_no_reply`).
   */
  async dismiss(input: ByIdAndUserInput): Promise<ApiCommunicationRecord> {
    const record = await this.loadAuthorized(input.commId, input.userId);
    if (record.status !== 'drafted' && record.status !== 'recommended') {
      throw new IllegalActionError(
        `Cannot dismiss communication "${record.commId}" in state "${record.status}".`,
      );
    }

    await this.move(record, 'dismissed', input.userId);
    this.metricsClient.addMetric('CommunicationDismissed', MetricUnit.Count, 1);
    this.log.info('Communication dismissed', { commId: record.commId });

    return { ...record, status: 'dismissed' };
  }

  /** `needs_context → drafted` — recovery edge once the user supplies missing context. The
   * context TEXT itself is not persisted on the communication record by this task (Task 5's
   * re-run seam is out of scope here); the transition + audit trail is what Task 6 owns. */
  async supplyContext(input: SupplyContextInput): Promise<ApiCommunicationRecord> {
    const record = await this.loadAuthorized(input.commId, input.userId);
    const trimmed = input.text.trim();
    if (!trimmed) {
      throw new IllegalActionError('supplyContext requires non-empty text.');
    }
    if (record.status !== 'needs_context') {
      throw new IllegalActionError(
        `Cannot supply context for communication "${record.commId}" in state "${record.status}" ` +
          '(must be needs_context).',
      );
    }

    await this.move(record, 'drafted', input.userId);
    this.log.info('Context supplied — back to drafted', { commId: record.commId });

    return { ...record, status: 'drafted' };
  }
}

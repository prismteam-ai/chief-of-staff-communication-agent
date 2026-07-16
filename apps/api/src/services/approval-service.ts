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
import type { AgentTrigger } from '../agent-trigger.js';
import type { StyleFeedbackHook } from './style-feedback.js';

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
  /**
   * Re-enqueues a communication to the agent queue once `supplyContext` has persisted the user's
   * supplied text (Task 6 review fix). Same ingest→agent hand-off `apps/ingest/src/agent-trigger.ts`
   * uses — re-running the agent turn in-process here would pull the whole Bedrock/RAG/AgentCore
   * Memory dependency graph into the api Lambda, which owns none of it today; re-enqueuing to the
   * queue the agent Lambda already consumes is the minimal, cleanly-separated fix.
   */
  agentTrigger: AgentTrigger;
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  /** Injectable clock for deterministic tests; defaults to the real current time. */
  now?: () => Date;
  /**
   * Task 10 feedback loop (design.md §6 "approved and edited drafts feed back into the profile";
   * alakazam's prior-decision-reuse pattern): called once, after a draft's send is confirmed, with
   * the FINAL sent body — which is either the original draft (approved as-is) or an edited one
   * (`editDraft` already mutated `record.draft` before `approveDraft` ever runs), so this one call
   * site covers both triggers the brief names. Optional so every existing test/call site that
   * predates Task 10 keeps compiling unchanged; a hook failure never fails the send (see the call
   * site's isolation comment).
   */
  styleFeedbackHook?: StyleFeedbackHook;
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
  private readonly agentTrigger: AgentTrigger;
  private readonly log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>;
  private readonly metricsClient: Pick<typeof MetricsType, 'addMetric'>;
  private readonly now: () => Date;
  private readonly styleFeedbackHook?: StyleFeedbackHook;

  constructor(deps: ApprovalServiceDeps) {
    this.communicationsRepo = deps.communicationsRepo;
    this.accountsRepo = deps.accountsRepo;
    this.connectorFor = deps.connectorFor;
    this.agentTrigger = deps.agentTrigger;
    this.log = deps.log;
    this.metricsClient = deps.metricsClient;
    this.now = deps.now ?? (() => new Date());
    this.styleFeedbackHook = deps.styleFeedbackHook;
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
    patch?: { draft?: Draft; appendSuppliedContext?: string },
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
   *
   * ## Pure self-thread fallback (found live, Task 6 verification)
   * `just verify-ingest`'s self-addressed probe (and any genuine note-to-self email) produces a
   * record where EVERY participant is the account's own address — `to`/`cc`/`from` all filter down
   * to empty under "everyone except myself". That is not an error case: the correct reply target
   * for a message the account sent itself is the account's own address (there is no other party to
   * address). Only once both the to/cc pass and the from-fallback are empty does this fall back to
   * the account's own address, so a genuine cross-party thread is never redirected to self.
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
    if (fromParticipant) return [fromParticipant.id];

    // Pure self-thread: every participant IS the account's own address — reply to self (see
    // doc comment above). `ownAddress` is only undefined if the accounts table has no address on
    // file, which `approveDraft`'s send would fail on regardless; falling back to any participant
    // id (they are all equal in this branch) keeps this total rather than throwing here.
    return ownAddress ? [ownAddress] : record.participants[0] ? [record.participants[0].id] : [];
  }

  /**
   * Task 10 feedback loop entry point. Resolves `accountId -> userId` (the style-profiles table's
   * key, same hop `run-agent-turn.ts`'s `accounts-repo.ts` performs on the agent side) and hands
   * the final sent body to the injected `styleFeedbackHook`. A no-op, not an error, when the hook
   * is unwired (pre-Task-10 deploys) or the account has no resolvable owner. Every failure mode is
   * caught and logged/counted — never thrown — because by the time this runs the send is ALREADY
   * durably confirmed (see the call site's comment).
   */
  private async feedBackStyleExemplarIsolated(
    record: ApiCommunicationRecord,
    finalBody: string,
  ): Promise<void> {
    if (!this.styleFeedbackHook) return;
    try {
      const userId = await this.accountsRepo.getOwner(record.accountId);
      if (!userId) {
        this.log.warn('Skipping style feedback — no resolvable owner for account', {
          commId: record.commId,
        });
        return;
      }
      await this.styleFeedbackHook.recordSentReply({
        userId,
        accountId: record.accountId,
        commId: record.commId,
        body: finalBody,
        recipients: await this.resolveReplyRecipients(record),
        ts: this.now().toISOString(),
      });
      this.metricsClient.addMetric('StyleExemplarAdded', MetricUnit.Count, 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Style feedback loop failed — send still succeeded', {
        commId: record.commId,
        error: message,
      });
      this.metricsClient.addMetric('StyleFeedbackFailed', MetricUnit.Count, 1);
    }
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
   * sitting in `awaiting_approval` (opened for review) skips the first hop; a record already sitting
   * in `approved` (a PRIOR call claimed the send but the connector then threw — see the `catch`
   * below, "record left at approved, not sent") skips straight to the send handoff, so a retried
   * approval on a genuinely failed send can succeed instead of being permanently stuck (found live,
   * Task 6 verification: a `SendFailed` record had no legal way back into `approveDraft` before this
   * branch existed). Send is claimed via a conditional write BEFORE the connector is invoked (Task 6
   * brief constraint 2: idempotent send, "a retried approval doesn't double-send") — a second call
   * on an already-`sent`/`answered` record fails fast on the state check, and a genuinely concurrent
   * race, or a retry after a send that actually succeeded despite an error, is caught by
   * `claimSend`'s own conditional write (`SendAlreadyClaimedError`).
   */
  async approveDraft(input: ByIdAndUserInput): Promise<ApiCommunicationRecord> {
    let record = await this.loadAuthorized(input.commId, input.userId);

    const retryingFailedSend = record.status === 'approved';
    if (
      record.status !== 'drafted' &&
      record.status !== 'awaiting_approval' &&
      !retryingFailedSend
    ) {
      throw new IllegalActionError(
        `Cannot approve communication "${record.commId}" in state "${record.status}" ` +
          '(must be drafted, awaiting_approval, or approved-with-a-failed-send to retry).',
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

    if (!retryingFailedSend) {
      await this.move(record, 'approved', input.userId);
      record = { ...record, status: 'approved' };
      this.metricsClient.addMetric('DraftApproved', MetricUnit.Count, 1);
    }

    // --- send handoff: claim BEFORE calling the connector (idempotency, brief constraint 2) ----
    // On retry, CAS on the prior claim timestamp (see claimSend's doc comment) rather than
    // requiring no claim at all — a first attempt always left one behind.
    await this.communicationsRepo.claimSend(
      record.commId,
      retryingFailedSend ? record.sendClaimedAt : undefined,
    );

    const replyRecipients = await this.resolveReplyRecipients(record);
    const startedAt = this.now().getTime();

    let sendResult;
    try {
      sendResult = await connector.send({
        accountId: record.accountId,
        threadKey: record.threadKey,
        inReplyToExternalId: record.externalId,
        inReplyToMessageId: record.providerMessageIdHeader,
        // The original message's subject (Task 6 review fix) — `undefined` on legacy records
        // ingested before `subject` was captured, which `ensureReSubject`/`build-outbound-mime.ts`
        // already falls back to `(no subject)` for. A freshly ingested message carries the real
        // subject captured by `normalize.ts`, so the reply correctly threads as `Re: <original>`.
        subject: record.subject,
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

    // Task 10 feedback loop (design.md §6, alakazam prior-decision-reuse): the FINAL sent body —
    // `draft.body` here already reflects any `editDraft` edit, since edits mutate `record.draft`
    // before approval ever runs — becomes a new style exemplar for future drafts. Isolated the
    // same way `run-agent-turn.ts`'s memory append is: the send is already durably confirmed
    // (`sent -> answered` above), so a feedback-loop failure must never undo or fail that outcome.
    await this.feedBackStyleExemplarIsolated(record, draft.body);

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

  /**
   * `needs_context → awaiting_reprocess` — recovery edge once the user supplies missing context
   * (Task 6 review fix). A `needs_context` record has NO draft (the agent never got far enough to
   * write one); the previous `needs_context → drafted` shortcut discarded the supplied text and
   * landed a draftless record in `drafted`, where the UI's Approve action had nothing to approve
   * (`IllegalActionError('no draft to approve')`, always). This now:
   *
   *   1. persists the supplied text onto the record (`suppliedContext`, appended — never dropped)
   *   2. transitions `needs_context → awaiting_reprocess` (a state marker: "context supplied,
   *      agent re-run pending" — not a terminal outcome)
   *   3. re-enqueues `{commId, accountId}` to the agent queue, the SAME hand-off the ingest
   *      processor uses (`apps/ingest/src/agent-trigger.ts`) — the agent Lambda already consumes
   *      this queue, so no new consumer is needed
   *
   * The re-triggered agent turn (`run-agent-turn.ts`) re-enters at `awaiting_reprocess →
   * recommended`, threads `suppliedContext` into the classify/draft prompt as additional history,
   * and proceeds through the same confidence-gated fork the first pass used — landing in `drafted`
   * WITH a draft, or back in `needs_context` if still below threshold. Server-side, account-guarded
   * (via `loadAuthorized` above), and idempotent: `communicationsRepo.transition`'s conditional
   * write only lets ONE call move a given record off `needs_context`, so a retried request either
   * lands the same append-and-enqueue exactly once or fails closed with `TransitionConflictError`.
   *
   * Fully re-running the agent in-process in this Lambda was considered and rejected: it would pull
   * Bedrock, the RAG retrieval index, and AgentCore Memory conversation state into the api Lambda,
   * none of which it owns today (see `ApprovalServiceDeps.agentTrigger`'s doc comment). Re-enqueuing
   * to the existing agent queue is the clean, minimally-invasive choice given the current wiring.
   */
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

    await this.move(record, 'awaiting_reprocess', input.userId, {
      appendSuppliedContext: trimmed,
    });

    // Isolated the same way the ingest processor treats its agent-trigger publish (see
    // `agent-trigger.ts`): the context is already durably persisted and the state transition
    // already committed above — that IS the successful outcome of this call. A publish failure
    // (or an unwired AGENT_QUEUE_URL) must never roll back or fail the user-visible action; it
    // degrades to a warn + metric, leaving the record at `awaiting_reprocess` for operator visibility
    // rather than silently claiming a re-run that didn't actually get enqueued.
    try {
      await this.agentTrigger.publish({ commId: record.commId, accountId: record.accountId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Failed to re-enqueue agent turn after supplyContext — context still saved', {
        commId: record.commId,
        error: message,
      });
      this.metricsClient.addMetric('AgentReprocessTriggerFailed', MetricUnit.Count, 1);
    }

    this.log.info('Context supplied — re-enqueued for agent re-run', { commId: record.commId });

    return {
      ...record,
      status: 'awaiting_reprocess',
      suppliedContext: [...(record.suppliedContext ?? []), trimmed],
    };
  }
}

import {
  assertAccountAccess,
  isHandled,
  type AccountOwnershipMap,
  type ChannelType,
  type CommunicationState,
} from '@chief-of-staff/shared';
import type { ApiCommunicationRecord, CommunicationsRepo } from '../repos/communications-repo.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';

/**
 * Dashboard aggregation service (design.md §8, Task 8 brief constraints 2-4): metrics, the
 * recommended-actions list, and the drafts-awaiting-approval list are all computed HERE, server-
 * side, from the account-scoped `listByAccount` read — never in the browser from a full dump
 * (brief constraint 4: that would leak cross-account data and not scale). Every method starts by
 * asserting `userId` owns `accountId` via the SAME `assertAccountAccess` guard `ApprovalService`/
 * `AsanaService` already route every read/write through (design.md §10) — the permission boundary
 * is provable at this one seam, not re-derived per view.
 *
 * `listByAccount` queries the `byAccountStatus` GSI already provisioned for the approval loop
 * (Task 6) — no new table, no full-table scan. For demo-scale data this is a single Query per
 * dashboard load; a production-scale version would push status/date filtering into the GSI key
 * condition instead of filtering in-process, but the account-scoping property (never reading
 * another account's partition) holds regardless of that later optimization.
 *
 * The returned shapes are deliberately PII-free (Task 8 brief constraint 4: "NO PII in the metrics
 * payloads — counts/durations/actionTypes/channels only"): `DashboardMetrics` carries no message
 * body, participant, or rationale text. `listRecommendedActions`/`listDraftsAwaitingApproval` DO
 * return full communication records (the dashboard views need the rationale/draft body to let a
 * human act) — those two are working-set views, not the metrics payload, and design.md never
 * scopes the PII constraint to them.
 */

/** The human-actionable queue: recommendation produced but not yet resolved by the user. */
const PENDING_APPROVAL_STATES: readonly CommunicationState[] = [
  'drafted',
  'awaiting_approval',
  'needs_context',
];

/** Response-time goal proxy (design.md §7): unanswered/undismissed past this many minutes since
 * ingestion is flagged overdue on the dashboard (README L34's <5-minute goal, "supported, not
 * enforced"). */
const OVERDUE_THRESHOLD_MINUTES = 5;

export interface DashboardMetricsInput {
  accountId: string;
  userId: string;
}

export interface ResponseTimeStats {
  sampleCount: number;
  averageSeconds: number | null;
  medianSeconds: number | null;
  /** Count of answered communications resolved inside the README L34 5-minute goal. */
  underFiveMinutesCount: number;
}

export interface DashboardMetrics {
  totalVolume: number;
  /** Every state's count, always present (zero-filled) so the UI never has to guard a missing key. */
  statusBreakdown: Record<CommunicationState, number>;
  channelBreakdown: Partial<Record<ChannelType, number>>;
  overdueCount: number;
  pendingApprovalsCount: number;
  /** answered ∪ dismissed — design.md §7's "handled" definition (`isHandled`). */
  handledCount: number;
  responseTime: ResponseTimeStats;
}

function ownershipMapFor(accountId: string, ownerUserId: string | undefined): AccountOwnershipMap {
  return ownerUserId ? { [accountId]: ownerUserId } : {};
}

function zeroedStatusBreakdown(): Record<CommunicationState, number> {
  return {
    ingested: 0,
    recommended: 0,
    drafted: 0,
    awaiting_approval: 0,
    approved: 0,
    sent: 0,
    answered: 0,
    edited: 0,
    rejected: 0,
    dismissed: 0,
    needs_context: 0,
    awaiting_reprocess: 0,
  };
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Earliest `ingested -> *` transition timestamp, falling back to `ingestedAt` for records
 * with no recorded transition (e.g. very old/seed data). */
function ingestedAtSeconds(record: ApiCommunicationRecord): number {
  const ingestedTransition = record.transitions?.find((t) => t.from === 'ingested');
  const iso = ingestedTransition?.ts ?? record.ingestedAt;
  return new Date(iso).getTime() / 1000;
}

/** Latest `* -> answered` transition timestamp, if the record has been answered. */
function answeredAtSeconds(record: ApiCommunicationRecord): number | undefined {
  const answeredTransition = [...(record.transitions ?? [])]
    .reverse()
    .find((t) => t.to === 'answered');
  return answeredTransition ? new Date(answeredTransition.ts).getTime() / 1000 : undefined;
}

export interface MetricsServiceDeps {
  communicationsRepo: CommunicationsRepo;
  accountsRepo: AccountsRepo;
  /** Injectable clock for deterministic tests (the overdue calculation is time-relative); defaults
   * to the real current time. */
  now?: () => Date;
}

export class MetricsService {
  private readonly communicationsRepo: CommunicationsRepo;
  private readonly accountsRepo: AccountsRepo;
  private readonly now: () => Date;

  constructor(deps: MetricsServiceDeps) {
    this.communicationsRepo = deps.communicationsRepo;
    this.accountsRepo = deps.accountsRepo;
    this.now = deps.now ?? (() => new Date());
  }

  private async assertAccountOwned(accountId: string, userId: string): Promise<void> {
    const ownerUserId = await this.accountsRepo.getOwner(accountId);
    assertAccountAccess(userId, accountId, ownershipMapFor(accountId, ownerUserId));
  }

  private async loadAccountScoped(
    input: DashboardMetricsInput,
  ): Promise<ApiCommunicationRecord[]> {
    await this.assertAccountOwned(input.accountId, input.userId);
    return this.communicationsRepo.listByAccount(input.accountId);
  }

  async getDashboardMetrics(input: DashboardMetricsInput): Promise<DashboardMetrics> {
    const records = await this.loadAccountScoped(input);
    const nowSeconds = this.now().getTime() / 1000;

    const statusBreakdown = zeroedStatusBreakdown();
    const channelBreakdown: Partial<Record<ChannelType, number>> = {};
    let overdueCount = 0;
    let handledCount = 0;
    let pendingApprovalsCount = 0;
    const responseTimeSeconds: number[] = [];
    let underFiveMinutesCount = 0;

    for (const record of records) {
      statusBreakdown[record.status] += 1;
      channelBreakdown[record.channelType] = (channelBreakdown[record.channelType] ?? 0) + 1;

      if (PENDING_APPROVAL_STATES.includes(record.status)) {
        pendingApprovalsCount += 1;
      }

      const handled = isHandled(record.status);
      if (handled) handledCount += 1;

      if (!handled) {
        const elapsedMinutes = (nowSeconds - ingestedAtSeconds(record)) / 60;
        if (elapsedMinutes > OVERDUE_THRESHOLD_MINUTES) overdueCount += 1;
      }

      if (record.status === 'answered') {
        const answeredAt = answeredAtSeconds(record);
        if (answeredAt !== undefined) {
          const duration = answeredAt - ingestedAtSeconds(record);
          responseTimeSeconds.push(duration);
          if (duration <= OVERDUE_THRESHOLD_MINUTES * 60) underFiveMinutesCount += 1;
        }
      }
    }

    const sorted = [...responseTimeSeconds].sort((a, b) => a - b);
    const averageSeconds =
      responseTimeSeconds.length > 0
        ? responseTimeSeconds.reduce((sum, s) => sum + s, 0) / responseTimeSeconds.length
        : null;

    return {
      totalVolume: records.length,
      statusBreakdown,
      channelBreakdown,
      overdueCount,
      pendingApprovalsCount,
      handledCount,
      responseTime: {
        sampleCount: responseTimeSeconds.length,
        averageSeconds,
        medianSeconds: median(sorted),
        underFiveMinutesCount,
      },
    };
  }

  /** Recommended-actions view (README L36): every communication carrying a recommendation,
   * most-recent-first (by the message's own timestamp, not ingestion time). */
  async listRecommendedActions(
    input: DashboardMetricsInput,
  ): Promise<ApiCommunicationRecord[]> {
    const records = await this.loadAccountScoped(input);
    return records
      .filter((r) => r.recommendation !== undefined)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  }

  /** Drafts-awaiting-approval view (README L37): drafted/awaiting_approval records that actually
   * carry a non-empty draft body — mirrors `canApproveCommunication`'s gate in the web UI. */
  async listDraftsAwaitingApproval(
    input: DashboardMetricsInput,
  ): Promise<ApiCommunicationRecord[]> {
    const records = await this.loadAccountScoped(input);
    return records
      .filter(
        (r) =>
          (r.status === 'drafted' || r.status === 'awaiting_approval') &&
          Boolean(r.draft?.body?.trim()),
      )
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  }
}

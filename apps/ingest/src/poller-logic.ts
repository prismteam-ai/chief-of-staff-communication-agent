import type { gmail_v1 } from 'googleapis';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import type { AccountsRepo, StoredAccount } from './accounts-repo.js';
import type { logger as LoggerType, metrics as MetricsType } from './context.js';

/**
 * Pure-ish poller logic (design.md §5, brief constraint 3): "EventBridge Scheduler rate(1 minute)
 * → poller Lambda (per active gmail account: `users.history.list` with stored historyId cursor on
 * the account record; first run seeds cursor from `users.getProfile` — NO backfill, per plan
 * continuous-seeding decision) → enqueue message-ids to SQS queue".
 *
 * Gmail API calls are injected (`GmailClientFactory`) so this module is unit-testable without a
 * real Gmail client; the Lambda handler wires the real `createGmailClientForAccount`.
 */

export type GmailClientFactory = (accountId: string) => Promise<gmail_v1.Gmail>;

export interface EnqueueMessage {
  accountId: string;
  messageId: string;
}

export type EnqueueFn = (messages: EnqueueMessage[]) => Promise<void>;

export interface PollAccountResult {
  accountId: string;
  seeded: boolean;
  enqueuedCount: number;
}

/**
 * True when `error` is the Gmail API's 404 for `users.history.list` called with a `startHistoryId`
 * that has aged out of Gmail's history retention window (Gmail keeps history records for a
 * rolling ~1 week; an account left unpolled longer than that — e.g. a paused EventBridge schedule
 * or a long deploy gap — has a cursor Gmail can no longer resolve). `googleapis`/`gaxios` surfaces
 * this as a thrown error whose HTTP status shows up under any of `code`, `status`, or
 * `response.status` depending on client version, so all three are checked defensively.
 */
function isExpiredHistoryCursorError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return err.code === 404 || err.status === 404 || err.response?.status === 404;
}

/**
 * Polls one account: seeds the cursor on first run (no messages enqueued — continuous-seeding
 * decision, not backfill), otherwise walks `history.list` (paginating via `nextPageToken`) and
 * enqueues every `messagesAdded` message id found, then advances the stored cursor to the
 * response's `historyId`.
 */
async function seedHistoryCursor(
  gmail: gmail_v1.Gmail,
  account: StoredAccount,
  accountsRepo: AccountsRepo,
): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const historyId = profile.data.historyId;
  if (!historyId) {
    throw new Error(`users.getProfile for account ${account.accountId} returned no historyId`);
  }
  await accountsRepo.updateHistoryCursor(account.accountId, historyId);
  return historyId;
}

export async function pollAccount(
  account: StoredAccount,
  gmailClientFactory: GmailClientFactory,
  accountsRepo: AccountsRepo,
  enqueue: EnqueueFn,
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>,
): Promise<PollAccountResult> {
  const gmail = await gmailClientFactory(account.accountId);

  if (!account.historyCursor) {
    await seedHistoryCursor(gmail, account, accountsRepo);
    log.info('Seeded Gmail history cursor (no backfill)', { accountId: account.accountId });
    return { accountId: account.accountId, seeded: true, enqueuedCount: 0 };
  }

  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = account.historyCursor;

  try {
    do {
      const response = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: account.historyCursor,
        historyTypes: ['messageAdded'],
        pageToken,
      });

      for (const record of response.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const id = added.message?.id;
          if (id) messageIds.add(id);
        }
      }

      if (response.data.historyId) {
        latestHistoryId = response.data.historyId;
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (error) {
    if (!isExpiredHistoryCursorError(error)) throw error;

    // The stored cursor is older than Gmail's history retention window, so `history.list` can
    // never resolve it again — any messages that arrived in the unpolled gap are unrecoverable
    // through this endpoint (Gmail does not offer a way to list "everything since a historyId
    // that no longer exists"). We deliberately accept that gap as lost rather than falling back
    // to a full backfill (out of scope per the continuous-seeding decision this poller already
    // follows on first run) and re-seed from the current profile so polling resumes cleanly on
    // the next tick. This is a real, visible data-loss event, not a silent skip — it is logged at
    // `warn` (not just `info`) specifically so it is distinguishable from routine ticks.
    log.warn(
      'Gmail history cursor expired (404) — messages in the unpolled gap are lost; re-seeding cursor',
      {
        accountId: account.accountId,
        staleCursor: account.historyCursor,
      },
    );
    await seedHistoryCursor(gmail, account, accountsRepo);
    // No messages are enqueued for a re-seed, matching the first-run (no-backfill) path above.
    return { accountId: account.accountId, seeded: true, enqueuedCount: 0 };
  }

  if (messageIds.size > 0) {
    await enqueue(
      Array.from(messageIds).map((messageId) => ({ accountId: account.accountId, messageId })),
    );
  }

  if (latestHistoryId !== account.historyCursor) {
    await accountsRepo.updateHistoryCursor(account.accountId, latestHistoryId);
  }

  log.info('Polled Gmail account', {
    accountId: account.accountId,
    enqueuedCount: messageIds.size,
  });
  return { accountId: account.accountId, seeded: false, enqueuedCount: messageIds.size };
}

/** Polls every active Gmail account; one account's failure is logged and does not abort the rest. */
export async function pollAllAccounts(
  accountsRepo: AccountsRepo,
  gmailClientFactory: GmailClientFactory,
  enqueue: EnqueueFn,
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>,
  metricsClient: Pick<typeof MetricsType, 'addMetric'>,
): Promise<PollAccountResult[]> {
  const accounts = await accountsRepo.listActiveAccountsByChannel('gmail');
  const results: PollAccountResult[] = [];

  for (const account of accounts) {
    try {
      results.push(await pollAccount(account, gmailClientFactory, accountsRepo, enqueue, log));
    } catch (error) {
      log.error('Failed to poll Gmail account', {
        accountId: account.accountId,
        error: error instanceof Error ? error.message : String(error),
      });
      metricsClient.addMetric('MessageFailed', MetricUnit.Count, 1);
    }
  }

  return results;
}

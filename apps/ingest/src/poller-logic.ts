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
 * Polls one account: seeds the cursor on first run (no messages enqueued — continuous-seeding
 * decision, not backfill), otherwise walks `history.list` (paginating via `nextPageToken`) and
 * enqueues every `messagesAdded` message id found, then advances the stored cursor to the
 * response's `historyId`.
 */
export async function pollAccount(
  account: StoredAccount,
  gmailClientFactory: GmailClientFactory,
  accountsRepo: AccountsRepo,
  enqueue: EnqueueFn,
  log: Pick<typeof LoggerType, 'info' | 'warn' | 'error'>,
): Promise<PollAccountResult> {
  const gmail = await gmailClientFactory(account.accountId);

  if (!account.historyCursor) {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const historyId = profile.data.historyId;
    if (!historyId) {
      throw new Error(`users.getProfile for account ${account.accountId} returned no historyId`);
    }
    await accountsRepo.updateHistoryCursor(account.accountId, historyId);
    log.info('Seeded Gmail history cursor (no backfill)', { accountId: account.accountId });
    return { accountId: account.accountId, seeded: true, enqueuedCount: 0 };
  }

  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = account.historyCursor;

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

  if (messageIds.size > 0) {
    await enqueue(
      Array.from(messageIds).map((messageId) => ({ accountId: account.accountId, messageId })),
    );
  }

  if (latestHistoryId !== account.historyCursor) {
    await accountsRepo.updateHistoryCursor(account.accountId, latestHistoryId);
  }

  log.info('Polled Gmail account', { accountId: account.accountId, enqueuedCount: messageIds.size });
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

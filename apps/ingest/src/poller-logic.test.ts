import { describe, expect, it, vi } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import type { AccountsRepo, StoredAccount } from './accounts-repo.js';
import { pollAccount, pollAllAccounts, type EnqueueMessage, type GmailClientFactory } from './poller-logic.js';

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    accountId: 'acct_demo-alex-gmail',
    userId: 'demo-alex',
    channelType: 'gmail',
    displayName: 'demoalex775@gmail.com',
    credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:000000000000:secret:cos/gmail-token-acct_demo-alex-gmail',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAccountsRepo(overrides: Partial<AccountsRepo> = {}): AccountsRepo {
  return {
    getAccount: vi.fn(),
    listActiveAccountsByChannel: vi.fn().mockResolvedValue([]),
    putAccount: vi.fn(),
    updateHistoryCursor: vi.fn(),
    ...overrides,
  };
}

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noopMetrics = { addMetric: vi.fn() };

describe('pollAccount', () => {
  it('seeds the history cursor from getProfile on first run and enqueues nothing (no backfill)', async () => {
    const account = makeAccount({ historyCursor: undefined });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: '1000' } }),
        history: { list: vi.fn() },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(result).toEqual({ accountId: account.accountId, seeded: true, enqueuedCount: 0 });
    expect(accountsRepo.updateHistoryCursor).toHaveBeenCalledWith(account.accountId, '1000');
    expect(enqueue).not.toHaveBeenCalled();
    expect(gmail.users.history.list).not.toHaveBeenCalled();
  });

  it('enqueues message ids found via history.list and advances the cursor', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const gmail = {
      users: {
        getProfile: vi.fn(),
        history: {
          list: vi.fn().mockResolvedValue({
            data: {
              historyId: '1050',
              history: [
                { messagesAdded: [{ message: { id: 'msg-1' } }] },
                { messagesAdded: [{ message: { id: 'msg-2' } }] },
              ],
            },
          }),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(result).toEqual({ accountId: account.accountId, seeded: false, enqueuedCount: 2 });
    expect(enqueue).toHaveBeenCalledWith([
      { accountId: account.accountId, messageId: 'msg-1' },
      { accountId: account.accountId, messageId: 'msg-2' },
    ]);
    expect(accountsRepo.updateHistoryCursor).toHaveBeenCalledWith(account.accountId, '1050');
  });

  it('deduplicates message ids appearing in multiple history records', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const gmail = {
      users: {
        getProfile: vi.fn(),
        history: {
          list: vi.fn().mockResolvedValue({
            data: {
              historyId: '1010',
              history: [
                { messagesAdded: [{ message: { id: 'msg-1' } }] },
                { messagesAdded: [{ message: { id: 'msg-1' } }] },
              ],
            },
          }),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(result.enqueuedCount).toBe(1);
  });

  it('paginates through history.list via nextPageToken', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          historyId: '1020',
          nextPageToken: 'page-2',
          history: [{ messagesAdded: [{ message: { id: 'msg-a' } }] }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          historyId: '1030',
          history: [{ messagesAdded: [{ message: { id: 'msg-b' } }] }],
        },
      });
    const gmail = { users: { getProfile: vi.fn(), history: { list } } } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(list).toHaveBeenCalledTimes(2);
    expect(result.enqueuedCount).toBe(2);
    expect(accountsRepo.updateHistoryCursor).toHaveBeenCalledWith(account.accountId, '1030');
  });

  it('re-seeds the cursor from getProfile when history.list throws a 404 (expired cursor) and does not crash', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const expiredCursorError = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: '9999' } }),
        history: { list: vi.fn().mockRejectedValue(expiredCursorError) },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(result).toEqual({ accountId: account.accountId, seeded: true, enqueuedCount: 0 });
    expect(gmail.users.getProfile).toHaveBeenCalledWith({ userId: 'me' });
    expect(accountsRepo.updateHistoryCursor).toHaveBeenCalledWith(account.accountId, '9999');
    expect(enqueue).not.toHaveBeenCalled();
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.stringMatching(/expired/i),
      expect.objectContaining({ accountId: account.accountId, staleCursor: '1000' }),
    );
  });

  it('detects the expired-cursor 404 via response.status when code/status are absent (client-version defensiveness)', async () => {
    const account = makeAccount({ historyCursor: '2000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const expiredCursorError = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: '5555' } }),
        history: { list: vi.fn().mockRejectedValue(expiredCursorError) },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(result.seeded).toBe(true);
    expect(accountsRepo.updateHistoryCursor).toHaveBeenCalledWith(account.accountId, '5555');
  });

  it('re-throws non-404 errors from history.list without touching the cursor', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const serverError = Object.assign(new Error('Internal error'), { code: 500 });
    const gmail = {
      users: {
        getProfile: vi.fn(),
        history: { list: vi.fn().mockRejectedValue(serverError) },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    await expect(pollAccount(account, factory, accountsRepo, enqueue, noopLog)).rejects.toThrow('Internal error');
    expect(gmail.users.getProfile).not.toHaveBeenCalled();
    expect(accountsRepo.updateHistoryCursor).not.toHaveBeenCalled();
  });

  it('does not advance the cursor when enqueue fails (batch send unrecoverably failed)', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockRejectedValue(new Error('SendMessageBatch: 1/2 entries still failed'));
    const gmail = {
      users: {
        getProfile: vi.fn(),
        history: {
          list: vi.fn().mockResolvedValue({
            data: { historyId: '1050', history: [{ messagesAdded: [{ message: { id: 'msg-1' } }] }] },
          }),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    await expect(pollAccount(account, factory, accountsRepo, enqueue, noopLog)).rejects.toThrow(
      /still failed/,
    );
    expect(accountsRepo.updateHistoryCursor).not.toHaveBeenCalled();
  });

  it('does not enqueue or advance the cursor when history.list finds nothing new', async () => {
    const account = makeAccount({ historyCursor: '1000' });
    const accountsRepo = makeAccountsRepo();
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const gmail = {
      users: {
        getProfile: vi.fn(),
        history: { list: vi.fn().mockResolvedValue({ data: { historyId: '1000', history: [] } }) },
      },
    } as unknown as gmail_v1.Gmail;
    const factory: GmailClientFactory = vi.fn().mockResolvedValue(gmail);

    const result = await pollAccount(account, factory, accountsRepo, enqueue, noopLog);

    expect(result.enqueuedCount).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(accountsRepo.updateHistoryCursor).not.toHaveBeenCalled();
  });
});

describe('pollAllAccounts', () => {
  it('polls every active gmail account and continues after one account fails', async () => {
    const accountA = makeAccount({ accountId: 'acct_a', historyCursor: undefined });
    const accountB = makeAccount({ accountId: 'acct_b', historyCursor: undefined });
    const accountsRepo = makeAccountsRepo({
      listActiveAccountsByChannel: vi.fn().mockResolvedValue([accountA, accountB]),
    });
    const enqueue = vi.fn<EnqueueFnSig>().mockResolvedValue(undefined);
    const factory: GmailClientFactory = vi.fn().mockImplementation(async (accountId: string) => {
      if (accountId === 'acct_a') {
        throw new Error('token expired');
      }
      return {
        users: { getProfile: vi.fn().mockResolvedValue({ data: { historyId: '2000' } }), history: { list: vi.fn() } },
      } as unknown as gmail_v1.Gmail;
    });

    const results = await pollAllAccounts(accountsRepo, factory, enqueue, noopLog, noopMetrics);

    expect(results).toHaveLength(1);
    expect(results[0]?.accountId).toBe('acct_b');
  });
});

type EnqueueFnSig = (messages: EnqueueMessage[]) => Promise<void>;

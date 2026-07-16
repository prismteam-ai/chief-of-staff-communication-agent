import { describe, expect, it } from 'vitest';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { createAccountsRouter } from './accounts.js';
import type { Context } from '../context.js';

/**
 * Router-level coverage for the connect-channel wizard's connected-accounts list (README L12,
 * Task 8 brief constraint 2): proves the DTO strips `credentialSecretArn` before it reaches the
 * client (design.md §10 — never even the ARN reference in the browser) and that the query is
 * scoped to exactly the `userId` the caller passed (permission boundary — brief constraint 3).
 */

function fakeAccountsRepo(): AccountsRepo {
  return {
    async getOwner() {
      return undefined;
    },
    async getOwnAddress() {
      return undefined;
    },
    async listByUser(userId) {
      if (userId !== 'demo-alex') return [];
      return [
        {
          accountId: 'acct-gmail-demoalex775',
          userId: 'demo-alex',
          channelType: 'gmail',
          displayName: 'demoalex775@gmail.com',
          credentialSecretArn: 'arn:aws:secretsmanager:us-east-2:123:secret:cos/gmail-token-x',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      ];
    },
  };
}

describe('accounts router — listConnectedAccounts', () => {
  it('returns the caller\'s own accounts without the credentialSecretArn', async () => {
    const router = createAccountsRouter(() => fakeAccountsRepo());
    const caller = router.createCaller({} as Context);

    const result = await caller.listConnectedAccounts({ userId: 'demo-alex' });

    expect(result).toEqual([
      {
        accountId: 'acct-gmail-demoalex775',
        channelType: 'gmail',
        displayName: 'demoalex775@gmail.com',
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('credentialSecretArn');
    expect(JSON.stringify(result)).not.toContain('secretsmanager');
  });

  it('returns an empty list for a user with no connected accounts', async () => {
    const router = createAccountsRouter(() => fakeAccountsRepo());
    const caller = router.createCaller({} as Context);

    const result = await caller.listConnectedAccounts({ userId: 'demo-blair' });

    expect(result).toEqual([]);
  });
});

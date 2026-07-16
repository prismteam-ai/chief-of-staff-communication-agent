import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { createAccountsRouter } from './accounts.js';
import type { Context } from '../context.js';
import {
  fakeAuthService,
  issueBearerToken,
  FORGED_TOKEN,
} from '../test-support/fake-auth-service.js';

/**
 * Router-level coverage for the connect-channel wizard's connected-accounts list (README L12,
 * Task 8 brief constraint 2): proves the DTO strips `credentialSecretArn` before it reaches the
 * client (design.md §10 — never even the ARN reference in the browser) and that the query is
 * scoped to exactly the TOKEN-resolved user (Task 8.5 — no more client-supplied `userId`).
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

function ctxWithToken(token?: string): Context {
  return { bearerToken: token } as unknown as Context;
}

describe('accounts router — listConnectedAccounts', () => {
  it("returns the caller's own accounts without the credentialSecretArn", async () => {
    const authService = fakeAuthService();
    const router = createAccountsRouter(
      () => fakeAccountsRepo(),
      () => authService,
    );
    const token = await issueBearerToken(authService, 'demo-alex');
    const caller = router.createCaller(ctxWithToken(token));

    const result = await caller.listConnectedAccounts();

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
    const authService = fakeAuthService();
    const router = createAccountsRouter(
      () => fakeAccountsRepo(),
      () => authService,
    );
    const token = await issueBearerToken(authService, 'demo-blair');
    const caller = router.createCaller(ctxWithToken(token));

    const result = await caller.listConnectedAccounts();

    expect(result).toEqual([]);
  });

  it('SECURITY: rejects a call with no Authorization header (401)', async () => {
    const authService = fakeAuthService();
    const router = createAccountsRouter(
      () => fakeAccountsRepo(),
      () => authService,
    );
    const caller = router.createCaller(ctxWithToken(undefined));

    await expect(caller.listConnectedAccounts()).rejects.toThrow(TRPCError);
  });

  it('SECURITY: rejects a forged/unknown bearer token (401)', async () => {
    const authService = fakeAuthService();
    const router = createAccountsRouter(
      () => fakeAccountsRepo(),
      () => authService,
    );
    const caller = router.createCaller(ctxWithToken(FORGED_TOKEN));

    await expect(caller.listConnectedAccounts()).rejects.toThrow(TRPCError);
  });
});

import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';

/**
 * Connected-channels list for the connect-channel wizard (README L12, Task 8 brief constraint 2:
 * "a page listing connected channels + a connect affordance"). Deliberately thin — no service
 * class needed since `listByUser` already IS the account-scoped query (it filters by the CALLER'S
 * OWN `userId`, not a caller-supplied `accountId` that would need an ownership lookup against a
 * different record — there is nothing to authorize beyond "list my own rows").
 *
 * `credentialSecretArn` is stripped before the DTO leaves this router — it is an ARN reference
 * (design.md §10: "no secret in code, logs, or the client bundle"), never the credential itself,
 * but there is no reason for the browser to see even the reference.
 */

export interface ConnectedAccountDto {
  accountId: string;
  channelType: string;
  displayName: string;
  createdAt: string;
}

export function createAccountsRouter(getRepo: (ctx: Context) => AccountsRepo) {
  return router({
    listConnectedAccounts: publicProcedure
      .input(z.object({ userId: z.string().min(1) }))
      .query(async ({ ctx, input }): Promise<ConnectedAccountDto[]> => {
        const accounts = await getRepo(ctx).listByUser(input.userId);
        return accounts.map((a) => ({
          accountId: a.accountId,
          channelType: a.channelType,
          displayName: a.displayName,
          createdAt: a.createdAt,
        }));
      }),
  });
}

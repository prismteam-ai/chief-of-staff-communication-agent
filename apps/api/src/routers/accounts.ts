import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { authedMiddleware } from '../services/authed-middleware.js';
import type { McpAuthService } from '../services/mcp-auth-service.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';

/**
 * Connected-channels list for the connect-channel wizard (README L12, Task 8 brief constraint 2:
 * "a page listing connected channels + a connect affordance"). Deliberately thin — no service
 * class needed since `listByUser` already IS the account-scoped query (it filters by the CALLER'S
 * OWN `userId`, not a caller-supplied `accountId` that would need an ownership lookup against a
 * different record — there is nothing to authorize beyond "list my own rows").
 *
 * `userId` is NOT a client input (Task 8.5): `listConnectedAccounts` sits behind
 * `authedMiddleware` and lists the TOKEN-resolved user's own accounts (`ctx.authedUserId`) — a
 * client can no longer list another user's connected channels merely by supplying their `userId`.
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

export function createAccountsRouter(
  getRepo: (ctx: Context) => AccountsRepo,
  getAuthService: () => McpAuthService,
) {
  const authed = publicProcedure.use(
    authedMiddleware(getAuthService, 'DashboardRequestAuthenticated'),
  );

  return router({
    listConnectedAccounts: authed.query(async ({ ctx }): Promise<ConnectedAccountDto[]> => {
      const userId = (ctx as Context & { authedUserId: string }).authedUserId;
      const accounts = await getRepo(ctx).listByUser(userId);
      return accounts.map((a) => ({
        accountId: a.accountId,
        channelType: a.channelType,
        displayName: a.displayName,
        createdAt: a.createdAt,
      }));
    }),
  });
}

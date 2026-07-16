import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { authedMiddleware } from '../services/authed-middleware.js';
import type { McpAuthService } from '../services/mcp-auth-service.js';
import { MetricsService } from '../services/metrics-service.js';

/**
 * The dashboard aggregation tRPC router (Task 8, design.md §8: "metrics view / recommended-actions
 * view / drafts-awaiting-approval view"). Same thin-adapter shape as `routers/communications.ts`
 * and `routers/asana.ts` — every procedure validates its zod input then calls the framework-free
 * `MetricsService`, which owns the account guard and every aggregation.
 *
 * `userId` is NOT a client input (Task 8.5): every procedure sits behind `authedMiddleware` and
 * reads `userId` from the verified bearer token (`ctx.authedUserId`) — a stranger typing someone
 * else's `accountId` here is still rejected by the service's ownership check, but they can no
 * longer supply an arbitrary `userId` to try it as in the first place.
 */

const AccountScopedInput = z.object({
  accountId: z.string().min(1),
});

export function createMetricsRouter(
  getService: (ctx: Context) => MetricsService,
  getAuthService: () => McpAuthService,
) {
  const authed = publicProcedure.use(
    authedMiddleware(getAuthService, 'DashboardRequestAuthenticated'),
  );
  const authedUserId = (ctx: unknown) => (ctx as Context & { authedUserId: string }).authedUserId;

  return router({
    getDashboardMetrics: authed
      .input(AccountScopedInput)
      .query(({ ctx, input }) =>
        getService(ctx).getDashboardMetrics({ ...input, userId: authedUserId(ctx) }),
      ),

    listRecommendedActions: authed
      .input(AccountScopedInput)
      .query(({ ctx, input }) =>
        getService(ctx).listRecommendedActions({ ...input, userId: authedUserId(ctx) }),
      ),

    listDraftsAwaitingApproval: authed
      .input(AccountScopedInput)
      .query(({ ctx, input }) =>
        getService(ctx).listDraftsAwaitingApproval({ ...input, userId: authedUserId(ctx) }),
      ),
  });
}

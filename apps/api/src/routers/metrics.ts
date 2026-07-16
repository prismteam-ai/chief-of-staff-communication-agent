import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { MetricsService } from '../services/metrics-service.js';

/**
 * The dashboard aggregation tRPC router (Task 8, design.md §8: "metrics view / recommended-actions
 * view / drafts-awaiting-approval view"). Same thin-adapter shape as `routers/communications.ts`
 * and `routers/asana.ts` — every procedure validates its zod input then calls the framework-free
 * `MetricsService`, which owns the account guard and every aggregation. `userId` is required on
 * every procedure (design.md §10 constraint 4 posture, unchanged from Task 6/7): the account-
 * ownership check runs server-side on every call regardless of how `userId` was obtained by the
 * client — a stranger typing someone else's `accountId` here is rejected by the service, not the
 * UI (Task 8 brief constraint 3).
 */

const AccountScopedInput = z.object({
  accountId: z.string().min(1),
  userId: z.string().min(1),
});

export function createMetricsRouter(getService: (ctx: Context) => MetricsService) {
  return router({
    getDashboardMetrics: publicProcedure
      .input(AccountScopedInput)
      .query(({ ctx, input }) => getService(ctx).getDashboardMetrics(input)),

    listRecommendedActions: publicProcedure
      .input(AccountScopedInput)
      .query(({ ctx, input }) => getService(ctx).listRecommendedActions(input)),

    listDraftsAwaitingApproval: publicProcedure
      .input(AccountScopedInput)
      .query(({ ctx, input }) => getService(ctx).listDraftsAwaitingApproval(input)),
  });
}

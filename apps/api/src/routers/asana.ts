import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { authedMiddleware } from '../services/authed-middleware.js';
import type { McpAuthService } from '../services/mcp-auth-service.js';
import { AsanaService } from '../services/asana-service.js';

/**
 * The Asana execution tRPC router (Task 7, design.md §9, brief constraint 3: "Execution via
 * human-approved tRPC (apps/api)"). Same thin-adapter shape as `routers/communications.ts`: every
 * procedure validates its zod input then calls the framework-free `AsanaService`, which owns the
 * account guard and the real Asana write.
 *
 * `userId` is NOT a client input (Task 8.5): every procedure sits behind `authedMiddleware` and
 * reads `userId` from the verified bearer token (`ctx.authedUserId`) — never from the request
 * body.
 */

export function createAsanaRouter(
  getService: (ctx: Context) => AsanaService,
  getAuthService: () => McpAuthService,
) {
  const authed = publicProcedure.use(
    authedMiddleware(getAuthService, 'DashboardRequestAuthenticated'),
  );
  const authedUserId = (ctx: unknown) => (ctx as Context & { authedUserId: string }).authedUserId;

  return router({
    createAsanaFollowup: authed
      .input(
        z.object({
          commId: z.string().min(1),
          title: z.string().min(1),
          notes: z.string().optional(),
          dueOn: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        getService(ctx).createAsanaFollowup({ ...input, userId: authedUserId(ctx) }),
      ),

    linkAsana: authed
      .input(
        z.object({
          commId: z.string().min(1),
          taskGid: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        getService(ctx).linkAsana({ ...input, userId: authedUserId(ctx) }),
      ),
  });
}

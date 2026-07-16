import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { AsanaService } from '../services/asana-service.js';

/**
 * The Asana execution tRPC router (Task 7, design.md §9, brief constraint 3: "Execution via
 * human-approved tRPC (apps/api)"). Same thin-adapter shape as `routers/communications.ts`: every
 * procedure validates its zod input then calls the framework-free `AsanaService`, which owns the
 * account guard and the real Asana write. `userId` is required on every procedure — same
 * design.md §10 constraint 4 posture as the communications router (accountId-scoped access; the
 * account-ownership check itself runs server-side on every call regardless of how `userId` was
 * obtained).
 */

export function createAsanaRouter(getService: (ctx: Context) => AsanaService) {
  return router({
    createAsanaFollowup: publicProcedure
      .input(
        z.object({
          commId: z.string().min(1),
          userId: z.string().min(1),
          title: z.string().min(1),
          notes: z.string().optional(),
          dueOn: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => getService(ctx).createAsanaFollowup(input)),

    linkAsana: publicProcedure
      .input(
        z.object({
          commId: z.string().min(1),
          userId: z.string().min(1),
          taskGid: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) => getService(ctx).linkAsana(input)),
  });
}

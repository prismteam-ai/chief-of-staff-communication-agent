import { z } from 'zod';
import { COMMUNICATION_STATES } from '@chief-of-staff/shared';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { authedMiddleware } from '../services/authed-middleware.js';
import type { McpAuthService } from '../services/mcp-auth-service.js';
import { ApprovalService } from '../services/approval-service.js';

/**
 * The approval-loop tRPC router (design.md §7/§8, Task 6 brief constraint 3): `listCommunications`,
 * `getCommunication`, `approveDraft`, `editDraft`, `rejectDraft`, `dismiss`, `supplyContext`. A thin
 * adapter — every procedure just validates its zod input then calls the framework-free
 * `ApprovalService`, which owns the account guard, the state-machine transitions, and the send
 * handoff.
 *
 * `userId` is NOT a client input on any procedure here (Task 8.5 closed that gap — it used to be a
 * plain, unauthenticated input, so a client could just type someone else's `userId` and the
 * server-side `assertAccountAccess` check would faithfully enforce a boundary around a fabricated
 * identity). Every procedure now sits behind `authedMiddleware`, the SAME bearer-token gate
 * `routers/mcp.ts` uses, and reads `userId` from the verified token
 * (`ctx.authedUserId`) — never from the request body.
 */

const CommunicationStateSchema = z.enum(COMMUNICATION_STATES);

export function createCommunicationsRouter(
  getService: (ctx: Context) => ApprovalService,
  getAuthService: () => McpAuthService,
) {
  const authed = publicProcedure.use(
    authedMiddleware(getAuthService, 'DashboardRequestAuthenticated'),
  );
  const authedUserId = (ctx: unknown) => (ctx as Context & { authedUserId: string }).authedUserId;

  return router({
    listCommunications: authed
      .input(
        z.object({
          accountId: z.string().min(1),
          status: CommunicationStateSchema.optional(),
        }),
      )
      .query(({ ctx, input }) =>
        getService(ctx).listCommunications({ ...input, userId: authedUserId(ctx) }),
      ),

    getCommunication: authed
      .input(z.object({ commId: z.string().min(1) }))
      .query(({ ctx, input }) =>
        getService(ctx).getCommunication({ ...input, userId: authedUserId(ctx) }),
      ),

    approveDraft: authed
      .input(z.object({ commId: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        getService(ctx).approveDraft({ ...input, userId: authedUserId(ctx) }),
      ),

    editDraft: authed
      .input(
        z.object({
          commId: z.string().min(1),
          newBody: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        getService(ctx).editDraft({ ...input, userId: authedUserId(ctx) }),
      ),

    rejectDraft: authed
      .input(z.object({ commId: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        getService(ctx).rejectDraft({ ...input, userId: authedUserId(ctx) }),
      ),

    dismiss: authed
      .input(z.object({ commId: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        getService(ctx).dismiss({ ...input, userId: authedUserId(ctx) }),
      ),

    supplyContext: authed
      .input(
        z.object({
          commId: z.string().min(1),
          text: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        getService(ctx).supplyContext({ ...input, userId: authedUserId(ctx) }),
      ),
  });
}

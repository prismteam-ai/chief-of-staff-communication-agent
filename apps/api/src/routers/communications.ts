import { z } from 'zod';
import { COMMUNICATION_STATES } from '@chief-of-staff/shared';
import { publicProcedure, router } from '../trpc.js';
import type { Context } from '../context.js';
import { ApprovalService } from '../services/approval-service.js';

/**
 * The approval-loop tRPC router (design.md §7/§8, Task 6 brief constraint 3): `listCommunications`,
 * `getCommunication`, `approveDraft`, `editDraft`, `rejectDraft`, `dismiss`, `supplyContext`. A thin
 * adapter — every procedure just validates its zod input then calls the framework-free
 * `ApprovalService`, which owns the account guard, the state-machine transitions, and the send
 * handoff. `userId` is a required input on every procedure (design.md §10 constraint 4: "a simple
 * accountId-scoped access is fine for now" — real per-user session auth is Task 8's hardening; the
 * account-ownership check itself, server-side against the accounts table, is NOT deferred and runs
 * on every call regardless of how `userId` was obtained).
 */

const CommunicationStateSchema = z.enum(COMMUNICATION_STATES);

export function createCommunicationsRouter(getService: (ctx: Context) => ApprovalService) {
  return router({
    listCommunications: publicProcedure
      .input(
        z.object({
          accountId: z.string().min(1),
          userId: z.string().min(1),
          status: CommunicationStateSchema.optional(),
        }),
      )
      .query(({ ctx, input }) => getService(ctx).listCommunications(input)),

    getCommunication: publicProcedure
      .input(z.object({ commId: z.string().min(1), userId: z.string().min(1) }))
      .query(({ ctx, input }) => getService(ctx).getCommunication(input)),

    approveDraft: publicProcedure
      .input(z.object({ commId: z.string().min(1), userId: z.string().min(1) }))
      .mutation(({ ctx, input }) => getService(ctx).approveDraft(input)),

    editDraft: publicProcedure
      .input(
        z.object({
          commId: z.string().min(1),
          userId: z.string().min(1),
          newBody: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) => getService(ctx).editDraft(input)),

    rejectDraft: publicProcedure
      .input(z.object({ commId: z.string().min(1), userId: z.string().min(1) }))
      .mutation(({ ctx, input }) => getService(ctx).rejectDraft(input)),

    dismiss: publicProcedure
      .input(z.object({ commId: z.string().min(1), userId: z.string().min(1) }))
      .mutation(({ ctx, input }) => getService(ctx).dismiss(input)),

    supplyContext: publicProcedure
      .input(
        z.object({
          commId: z.string().min(1),
          userId: z.string().min(1),
          text: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) => getService(ctx).supplyContext(input)),
  });
}

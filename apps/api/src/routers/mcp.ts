import { z } from 'zod';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  IssueMcpTokenInputSchema,
  IssueMcpTokenResultSchema,
  McpTokenInvalidError,
  assertAccountAccess,
  type AccountOwnershipMap,
} from '@chief-of-staff/shared';
import { TRPCError } from '@trpc/server';
import type { RetrievalIndex } from '@chief-of-staff/rag';
import { embedText, EMBED_INPUT_TYPE } from '@chief-of-staff/rag';
import { publicProcedure, router, middleware } from '../trpc.js';
import type { Context } from '../context.js';
import { McpAuthService } from '../services/mcp-auth-service.js';
import { ApprovalService } from '../services/approval-service.js';
import { AsanaService } from '../services/asana-service.js';
import type { AccountsRepo } from '../repos/accounts-repo.js';
import { metrics } from '../context.js';

/**
 * The MCP-facing tRPC router (Task 11, design.md §8): the ONE surface the Cursor MCP server calls
 * over HTTPS. Every procedure here (except `issueMcpToken`, the dashboard-facing mint operation)
 * requires a verified `Authorization: Bearer <token>` header — `ctx.mcpBearerToken` — and resolves
 * `userId` FROM the token, never from client input (brief constraint 3: "NEVER trust a
 * client-supplied userId when a token is present"). This is what makes a forged or another user's
 * token unable to widen access: every downstream service call (`ApprovalService`, `AsanaService`,
 * retrieval) still runs through the SAME `assertAccountAccess` guard every other path in this repo
 * uses, keyed off the token-resolved `userId`.
 *
 * `retrieveContext` is a genuinely new read (there was no tRPC procedure for it before Task 11) —
 * everything else (`recommendAction`, `draftReply`) is exposed as a READ over the already-produced
 * recommendation/draft fields on the communication record: the ingest→agent pipeline (Task 5)
 * already runs the LLM classify/draft step automatically for every ingested communication and
 * persists the result (`ApiCommunicationRecord.recommendation`/`.draft`); Cursor's "recommend
 * actions, draft responses" (README L38-L40) is fulfilled by surfacing that real, already-computed
 * work product through the hosted API, the same object the dashboard's own recommended-actions/
 * drafts-awaiting-approval views already render (`MetricsService`). This keeps the MCP server a
 * thin caller of the existing tool contract rather than standing up a second Bedrock-calling code
 * path in the API Lambda. `approveDraft`/`supplyContext`/Asana writes reuse the EXACT SAME
 * `ApprovalService`/`AsanaService` methods the dashboard's tRPC procedures call — one business-logic
 * implementation, two authenticated entry points.
 */

const mcpAuthedMiddleware = (getAuthService: () => McpAuthService) =>
  middleware(async ({ ctx, next }) => {
    if (!ctx.mcpBearerToken) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Missing Authorization: Bearer <token> header.',
      });
    }
    let userId: string;
    try {
      userId = await getAuthService().verify(ctx.mcpBearerToken);
    } catch (error) {
      if (error instanceof McpTokenInvalidError) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
      }
      throw error;
    }
    // One MCP-authenticated tool call successfully passed the bearer-token gate — cloudwatch-
    // metrics.json / api-stack.ts dashboard (brief constraint 5: "metrics McpToolInvoked/
    // McpTokenIssued/McpAuthFailed"). Counted here (not per-procedure) so every current and future
    // procedure behind `authed` is covered by construction.
    metrics.addMetric('McpToolInvoked', MetricUnit.Count, 1);
    return next({ ctx: { ...ctx, mcpUserId: userId } });
  });

function ownershipMapFor(accountId: string, ownerUserId: string | undefined): AccountOwnershipMap {
  return ownerUserId ? { [accountId]: ownerUserId } : {};
}

export interface McpRouterDeps {
  authService: () => McpAuthService;
  approvalService: () => ApprovalService;
  asanaService: () => AsanaService;
  accountsRepo: () => AccountsRepo;
  /** `undefined` when the RAG domain isn't wired for this deploy — `retrieveContext` then returns a
   * clear `PRECONDITION_FAILED` rather than crashing (same "degrade to a clear error" posture as
   * `ApprovalService`'s unwired-dependency checks elsewhere in this codebase). */
  retrievalIndex: () => RetrievalIndex | undefined;
  /** Injectable embedder so tests never call Bedrock; defaults to the real Cohere Embed v4 helper —
   * same seam `RetrieveContextDeps.embed` uses in the agent-handler's sibling tool. */
  embed?: (text: string) => Promise<number[]>;
}

export function createMcpRouter(deps: McpRouterDeps) {
  const authed = publicProcedure.use(mcpAuthedMiddleware(deps.authService));
  const embed = deps.embed ?? ((text: string) => embedText(text, EMBED_INPUT_TYPE.query));

  return router({
    /** Dashboard-facing token mint (Task 8's token-issuance view calls this) — NOT token-gated
     * itself (there is no token yet at mint time); the dashboard's own v0 auth posture applies
     * (design.md §10 constraint 4), same as every other dashboard-facing procedure in this repo. */
    issueMcpToken: publicProcedure
      .input(IssueMcpTokenInputSchema)
      .output(IssueMcpTokenResultSchema)
      .mutation(({ input }) => deps.authService().issue(input)),

    /** Real RAG retrieval (design.md §8: "RAG retrieval" — the one genuinely new read this task
     * adds). `accountId` must be owned by the token-resolved user; the query text/topK are the
     * only caller-chosen inputs, same permission-boundary shape `retrieveContext`'s agent-tool
     * sibling uses (`accountId` bound, never a free tool parameter). */
    retrieveContext: authed
      .input(
        z.object({
          accountId: z.string().min(1),
          query: z.string().min(1),
          topK: z.number().int().min(1).max(10).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const index = deps.retrievalIndex();
        if (!index) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'RAG domain not wired for this deploy.',
          });
        }
        const ownerUserId = await deps.accountsRepo().getOwner(input.accountId);
        assertAccountAccess(
          (ctx as Context & { mcpUserId: string }).mcpUserId,
          input.accountId,
          ownershipMapFor(input.accountId, ownerUserId),
        );

        const topK = input.topK ?? 5;
        const queryEmbedding = await embed(input.query);
        const hits = await index.search(queryEmbedding, input.query, {
          accountId: input.accountId,
          topK,
        });
        return {
          hits: hits.map((hit) => ({
            chunkId: hit.chunkId,
            sourceId: hit.sourceId,
            textForContext: hit.textForContext,
            score: hit.score,
            channel: hit.metadata.channel,
            sourceType: hit.metadata.sourceType,
          })),
        };
      }),

    /** Read-accessor over the agent's already-produced recommendation for `commId` (see module doc
     * comment: not a second LLM call). Reuses `ApprovalService.getCommunication`'s ownership guard. */
    recommendAction: authed
      .input(z.object({ commId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const record = await deps.approvalService().getCommunication({
          commId: input.commId,
          userId: (ctx as Context & { mcpUserId: string }).mcpUserId,
        });
        return {
          commId: record.commId,
          status: record.status,
          recommendation: record.recommendation ?? null,
        };
      }),

    /** Read-accessor over the agent's already-produced draft for `commId` (see module doc comment). */
    draftReply: authed
      .input(z.object({ commId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const record = await deps.approvalService().getCommunication({
          commId: input.commId,
          userId: (ctx as Context & { mcpUserId: string }).mcpUserId,
        });
        return { commId: record.commId, status: record.status, draft: record.draft ?? null };
      }),

    /**
     * WRITE — confirm-gated (brief constraint 2, hypno pattern). This procedure performs the send
     * the moment it is called; the MCP tool description (`mcp/src/tools/approve-draft.ts`) is what
     * makes the confirm gate real by requiring the CALLER (the Cursor agent, driven by the human's
     * explicit "yes, send it") to only invoke this after confirmation — there is no separate
     * "propose" step here because `ApprovalService.approveDraft` already IS the human-approved
     * execution step (the dashboard's own Approve button calls the exact same method).
     */
    approveDraft: authed.input(z.object({ commId: z.string().min(1) })).mutation(({ ctx, input }) =>
      deps.approvalService().approveDraft({
        commId: input.commId,
        userId: (ctx as Context & { mcpUserId: string }).mcpUserId,
      }),
    ),

    supplyContext: authed
      .input(z.object({ commId: z.string().min(1), text: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        deps.approvalService().supplyContext({
          commId: input.commId,
          text: input.text,
          userId: (ctx as Context & { mcpUserId: string }).mcpUserId,
        }),
      ),

    /** WRITE — confirm-gated (brief constraint 2). Same real-execution posture as `approveDraft`
     * above: `AsanaService.createAsanaFollowup` IS the human-approved write; the MCP tool
     * description is what requires the caller to confirm before invoking it. */
    manageAsanaCreate: authed
      .input(
        z.object({
          commId: z.string().min(1),
          title: z.string().min(1),
          notes: z.string().optional(),
          dueOn: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        deps.asanaService().createAsanaFollowup({
          ...input,
          userId: (ctx as Context & { mcpUserId: string }).mcpUserId,
        }),
      ),

    manageAsanaLink: authed
      .input(z.object({ commId: z.string().min(1), taskGid: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        deps.asanaService().linkAsana({
          ...input,
          userId: (ctx as Context & { mcpUserId: string }).mcpUserId,
        }),
      ),
  });
}

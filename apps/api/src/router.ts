import { TRPCError } from '@trpc/server';

import {
  createDraftInputSchema,
  createDraftResultSchema,
  createProductHealthResponse,
  getApprovalStatusInputSchema,
  getApprovalStatusResultSchema,
  getCommunicationInputSchema,
  getCommunicationResultSchema,
  getConnectorStatusInputSchema,
  getConnectorStatusResultSchema,
  getRelatedAsanaWorkInputSchema,
  getRelatedAsanaWorkResultSchema,
  getSlaMetricsInputSchema,
  getSlaMetricsResultSchema,
  getThreadContextInputSchema,
  getThreadContextResultSchema,
  productHealthResponseSchema,
  listCommunicationsInputSchema,
  listCommunicationsResultSchema,
  prepareAsanaActionInputSchema,
  prepareAsanaActionResultSchema,
  recommendActionInputSchema,
  recommendActionResultSchema,
  requestContextInputSchema,
  requestContextResultSchema,
  reviseDraftInputSchema,
  reviseDraftResultSchema,
  searchKnowledgeInputSchema,
  searchKnowledgeResultSchema,
  submitApprovalInputSchema,
  submitApprovalResultSchema,
} from '@chief/contracts';

import {
  approveProposalInputSchema,
  approveProposalResultSchema,
  dashboardMetricsResultSchema,
  executionStatusInputSchema,
  executionStatusResultSchema,
  prepareDraftApprovalInputSchema,
  prepareDraftApprovalResultSchema,
  ProductServiceError,
  type ProductResult,
} from './product-service.js';
import { publicProcedure, router } from './trpc.js';

function toTrpcError(error: unknown): never {
  if (!(error instanceof ProductServiceError)) throw error;
  const code =
    error.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'STALE_REVISION'
        ? 'CONFLICT'
        : error.code === 'FORBIDDEN_AUTHORITY'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
  throw new TRPCError({ code, message: error.message, cause: error });
}

async function productCall<T>(operation: () => ProductResult<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return toTrpcError(error);
  }
}

export const systemRouter = router({
  health: publicProcedure
    .output(productHealthResponseSchema)
    .query(({ ctx }) => {
      ctx.observability.logger.info('Product API health requested', {
        surface: 'typed-product-api',
        externalEffects: 'disabled',
      });
      return createProductHealthResponse('chief-api');
    }),
});

export const dashboardRouter = router({
  metrics: publicProcedure
    .input(getSlaMetricsInputSchema)
    .output(dashboardMetricsResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.dashboardMetrics(ctx.requestContext, input),
      ),
    ),
  sla: publicProcedure
    .input(getSlaMetricsInputSchema)
    .output(getSlaMetricsResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getSlaMetrics(ctx.requestContext, input),
      ),
    ),
});

export const communicationsRouter = router({
  list: publicProcedure
    .input(listCommunicationsInputSchema)
    .output(listCommunicationsResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.listCommunications(ctx.requestContext, input),
      ),
    ),
  get: publicProcedure
    .input(getCommunicationInputSchema)
    .output(getCommunicationResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getCommunication(ctx.requestContext, input),
      ),
    ),
  thread: publicProcedure
    .input(getThreadContextInputSchema)
    .output(getThreadContextResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getThreadContext(ctx.requestContext, input),
      ),
    ),
});

export const connectorsRouter = router({
  status: publicProcedure
    .input(getConnectorStatusInputSchema)
    .output(getConnectorStatusResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getConnectorStatus(ctx.requestContext, input),
      ),
    ),
});

export const workRouter = router({
  relatedAsana: publicProcedure
    .input(getRelatedAsanaWorkInputSchema)
    .output(getRelatedAsanaWorkResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getRelatedAsanaWork(ctx.requestContext, input),
      ),
    ),
});

export const knowledgeRouter = router({
  search: publicProcedure
    .input(searchKnowledgeInputSchema)
    .output(searchKnowledgeResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.searchKnowledge(ctx.requestContext, input),
      ),
    ),
});

export const agentRouter = router({
  recommend: publicProcedure
    .input(recommendActionInputSchema)
    .output(recommendActionResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.recommendAction(ctx.requestContext, input),
      ),
    ),
  createDraft: publicProcedure
    .input(createDraftInputSchema)
    .output(createDraftResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.createDraft(ctx.requestContext, input),
      ),
    ),
  reviseDraft: publicProcedure
    .input(reviseDraftInputSchema)
    .output(reviseDraftResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.reviseDraft(ctx.requestContext, input),
      ),
    ),
  requestContext: publicProcedure
    .input(requestContextInputSchema)
    .output(requestContextResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.requestContext(ctx.requestContext, input),
      ),
    ),
});

export const approvalsRouter = router({
  prepare: publicProcedure
    .input(submitApprovalInputSchema)
    .output(submitApprovalResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.prepareApproval(ctx.requestContext, input),
      ),
    ),
  prepareAsana: publicProcedure
    .input(prepareAsanaActionInputSchema)
    .output(prepareAsanaActionResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.prepareAsanaAction(ctx.requestContext, input),
      ),
    ),
  prepareDraft: publicProcedure
    .input(prepareDraftApprovalInputSchema)
    .output(prepareDraftApprovalResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.prepareDraftApproval(ctx.requestContext, input),
      ),
    ),
  approve: publicProcedure
    .input(approveProposalInputSchema)
    .output(approveProposalResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.approveProposal(ctx.requestContext, input),
      ),
    ),
  status: publicProcedure
    .input(getApprovalStatusInputSchema)
    .output(getApprovalStatusResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getApprovalStatus(ctx.requestContext, input),
      ),
    ),
});

export const executionRouter = router({
  status: publicProcedure
    .input(executionStatusInputSchema)
    .output(executionStatusResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getExecutionStatus(ctx.requestContext, input),
      ),
    ),
});

export const appRouter = router({
  agent: agentRouter,
  approvals: approvalsRouter,
  communications: communicationsRouter,
  connectors: connectorsRouter,
  dashboard: dashboardRouter,
  execution: executionRouter,
  knowledge: knowledgeRouter,
  system: systemRouter,
  work: workRouter,
});

export type AppRouter = typeof appRouter;

export {
  approveProposalInputSchema,
  approveProposalResultSchema,
  prepareDraftApprovalInputSchema,
  prepareDraftApprovalResultSchema,
} from './product-service.js';
export {
  createAwsDurableApiDependencies,
  createDefaultDurableApiDependencies,
  createDurableRequestContext,
  createMemoryDurableApiDependencies,
} from './aws-composition.js';
export type {
  ProductRequestContext,
  ProductService,
} from './product-service.js';

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
  asanaAcceptanceEvidenceResultSchema,
  createAsanaAcceptanceEvidenceResult,
} from './asana-acceptance-evidence.js';
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
import { protectedProcedure, publicProcedure, router } from './trpc.js';

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
  asanaAcceptanceEvidence: publicProcedure
    .output(asanaAcceptanceEvidenceResultSchema)
    .query(({ ctx }) => {
      ctx.observability.logger.info('Asana acceptance evidence requested', {
        surface: 'typed-product-api',
        externalEffects: 'disabled',
      });
      return createAsanaAcceptanceEvidenceResult();
    }),
});

export const dashboardRouter = router({
  metrics: protectedProcedure
    .input(getSlaMetricsInputSchema)
    .output(dashboardMetricsResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.dashboardMetrics(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  sla: protectedProcedure
    .input(getSlaMetricsInputSchema)
    .output(getSlaMetricsResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getSlaMetrics(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const communicationsRouter = router({
  list: protectedProcedure
    .input(listCommunicationsInputSchema)
    .output(listCommunicationsResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.listCommunications(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  get: protectedProcedure
    .input(getCommunicationInputSchema)
    .output(getCommunicationResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getCommunication(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  thread: protectedProcedure
    .input(getThreadContextInputSchema)
    .output(getThreadContextResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getThreadContext(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const connectorsRouter = router({
  status: protectedProcedure
    .input(getConnectorStatusInputSchema)
    .output(getConnectorStatusResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getConnectorStatus(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const workRouter = router({
  relatedAsana: protectedProcedure
    .input(getRelatedAsanaWorkInputSchema)
    .output(getRelatedAsanaWorkResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getRelatedAsanaWork(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const knowledgeRouter = router({
  search: protectedProcedure
    .input(searchKnowledgeInputSchema)
    .output(searchKnowledgeResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.searchKnowledge(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const agentRouter = router({
  recommend: protectedProcedure
    .input(recommendActionInputSchema)
    .output(recommendActionResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.recommendAction(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  createDraft: protectedProcedure
    .input(createDraftInputSchema)
    .output(createDraftResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.createDraft(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  reviseDraft: protectedProcedure
    .input(reviseDraftInputSchema)
    .output(reviseDraftResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.reviseDraft(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  requestContext: protectedProcedure
    .input(requestContextInputSchema)
    .output(requestContextResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.requestContext(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const approvalsRouter = router({
  prepare: protectedProcedure
    .input(submitApprovalInputSchema)
    .output(submitApprovalResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.prepareApproval(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  prepareAsana: protectedProcedure
    .input(prepareAsanaActionInputSchema)
    .output(prepareAsanaActionResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.prepareAsanaAction(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  prepareDraft: protectedProcedure
    .input(prepareDraftApprovalInputSchema)
    .output(prepareDraftApprovalResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.prepareDraftApproval(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  approve: protectedProcedure
    .input(approveProposalInputSchema)
    .output(approveProposalResultSchema)
    .mutation(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.approveProposal(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
  status: protectedProcedure
    .input(getApprovalStatusInputSchema)
    .output(getApprovalStatusResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getApprovalStatus(
          ctx.requestAuthority.requestContext,
          input,
        ),
      ),
    ),
});

export const executionRouter = router({
  status: protectedProcedure
    .input(executionStatusInputSchema)
    .output(executionStatusResultSchema)
    .query(({ ctx, input }) =>
      productCall(() =>
        ctx.productService.getExecutionStatus(
          ctx.requestAuthority.requestContext,
          input,
        ),
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
  createAwsDurableMcpDependencies,
  createDefaultDurableApiDependencies,
  createDurableRequestContext,
  createMemoryDurableApiDependencies,
} from './aws-composition.js';
export type { AwsDurableMcpDependencies } from './aws-composition.js';
export type {
  ProductRequestContext,
  ProductService,
} from './product-service.js';
export {
  RequestAuthorityError,
  createCognitoRequestAuthorityResolver,
  createCognitoSessionTokenVerifier,
  createRequestAuthorityResolver,
} from './auth/index.js';
export type {
  AuthorityMembershipResolution,
  AuthorityMembershipResolver,
  RequestAuthorityInput,
  RequestAuthorityResolver,
  ResolvedRequestAuthority,
  VerifiedSessionIdentity,
} from './auth/index.js';

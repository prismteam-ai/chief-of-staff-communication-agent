import {
  createAwsDurableApiDependencies,
  createMemoryDurableApiDependencies,
  type ProductRequestContext,
  type ProductService,
} from '@chief/api';
import type { McpToolName } from '@chief/contracts';

import {
  McpToolError,
  type McpRequestScope,
  type McpToolService,
} from './service.js';

function toToolError(error: unknown): never {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    if (error.code === 'NOT_FOUND') throw new McpToolError('NOT_FOUND');
    if (error.code === 'STALE_REVISION')
      throw new McpToolError('STALE_REVISION');
    if (error.code === 'BAD_CURSOR') throw new McpToolError('INVALID_CURSOR');
  }
  throw error;
}

export class ProductServiceMcpAdapter implements McpToolService {
  public constructor(
    private readonly product: ProductService,
    private readonly context: ProductRequestContext,
  ) {}

  public async call(
    toolName: McpToolName,
    input: unknown,
    scope: McpRequestScope,
  ): Promise<unknown> {
    if (
      scope.tenantId !== this.context.actor.tenantId ||
      scope.userId !== this.context.actor.userId
    ) {
      throw new McpToolError('SCOPE_VIOLATION');
    }
    try {
      switch (toolName) {
        case 'list_pending_communications':
          return await this.product.listCommunications(
            this.context,
            input as never,
          );
        case 'get_communication':
          return await this.product.getCommunication(
            this.context,
            input as never,
          );
        case 'get_thread_context':
          return await this.product.getThreadContext(
            this.context,
            input as never,
          );
        case 'search_knowledge':
          return await this.product.searchKnowledge(
            this.context,
            input as never,
          );
        case 'get_related_asana_work':
          return await this.product.getRelatedAsanaWork(
            this.context,
            input as never,
          );
        case 'recommend_action':
          return await this.product.recommendAction(
            this.context,
            input as never,
          );
        case 'create_draft':
          return await this.product.createDraft(this.context, input as never);
        case 'revise_draft':
          return await this.product.reviseDraft(this.context, input as never);
        case 'request_context':
          return await this.product.requestContext(
            this.context,
            input as never,
          );
        case 'prepare_asana_action':
          return await this.product.prepareAsanaAction(
            this.context,
            input as never,
          );
        case 'submit_for_approval':
          throw new McpToolError(
            'TOOL_UNAVAILABLE',
            'TOOL_UNAVAILABLE: submit_for_approval is legacy and unavailable in the durable fixed-scope MCP runtime; use the HTTPS product draft-approval flow.',
          );
        case 'get_approval_status':
          return await this.product.getApprovalStatus(
            this.context,
            input as never,
          );
        case 'get_connector_status':
          return await this.product.getConnectorStatus(
            this.context,
            input as never,
          );
        case 'get_sla_metrics':
          return await this.product.getSlaMetrics(this.context, input as never);
      }
    } catch (error) {
      return toToolError(error);
    }
  }
}

export function createDefaultMcpProductAdapter(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ service: McpToolService; scope: McpRequestScope }> {
  const dependencies =
    environment.NODE_ENV === 'test'
      ? createMemoryDurableApiDependencies({
          baseUrl: environment.CHIEF_PRODUCT_BASE_URL,
        })
      : createAwsDurableApiDependencies({
          ...environment,
          PRODUCT_BASE_URL: environment.CHIEF_PRODUCT_BASE_URL,
        });
  const context = dependencies.requestContext;
  return {
    service: new ProductServiceMcpAdapter(dependencies.productService, context),
    scope: {
      kind: 'public_fixture',
      tenantId: context.actor.tenantId,
      userId: context.actor.userId,
      authorizationEpoch: context.retrievalScope?.authorizationEpoch ?? 1,
    },
  };
}

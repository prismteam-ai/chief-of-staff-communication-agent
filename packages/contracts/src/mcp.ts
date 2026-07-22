import { z } from 'zod';

import {
  createDraftInputSchema,
  createDraftResultSchema,
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
  listCommunicationsInputSchema,
  listCommunicationsResultSchema,
  prepareAsanaActionInputSchema,
  prepareAsanaActionResultSchema,
  proposalHandoffSchema,
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
} from './api.js';

export const mcpToolNameSchema = z.enum([
  'list_pending_communications',
  'get_communication',
  'get_thread_context',
  'search_knowledge',
  'get_related_asana_work',
  'recommend_action',
  'create_draft',
  'revise_draft',
  'request_context',
  'prepare_asana_action',
  'submit_for_approval',
  'get_approval_status',
  'get_connector_status',
  'get_sla_metrics',
]);

export type McpToolName = z.infer<typeof mcpToolNameSchema>;

export const mcpListPendingInputSchema = listCommunicationsInputSchema;
export const mcpListPendingResultSchema = listCommunicationsResultSchema;
export const mcpGetCommunicationInputSchema = getCommunicationInputSchema;
export const mcpGetCommunicationResultSchema = getCommunicationResultSchema;
export const mcpGetThreadContextInputSchema = getThreadContextInputSchema;
export const mcpGetThreadContextResultSchema = getThreadContextResultSchema;
export const mcpSearchKnowledgeInputSchema = searchKnowledgeInputSchema;
export const mcpSearchKnowledgeResultSchema = searchKnowledgeResultSchema;
export const mcpGetRelatedAsanaWorkInputSchema = getRelatedAsanaWorkInputSchema;
export const mcpGetRelatedAsanaWorkResultSchema =
  getRelatedAsanaWorkResultSchema;
export const mcpRecommendActionInputSchema = recommendActionInputSchema;
export const mcpRecommendActionResultSchema = recommendActionResultSchema;
export const mcpCreateDraftInputSchema = createDraftInputSchema;
export const mcpCreateDraftResultSchema = createDraftResultSchema;
export const mcpReviseDraftInputSchema = reviseDraftInputSchema;
export const mcpReviseDraftResultSchema = reviseDraftResultSchema;
export const mcpRequestContextInputSchema = requestContextInputSchema;
export const mcpRequestContextResultSchema = requestContextResultSchema;
export const mcpPrepareAsanaActionInputSchema = prepareAsanaActionInputSchema;
export const mcpPrepareAsanaActionResultSchema = prepareAsanaActionResultSchema;
export const mcpSubmitForApprovalInputSchema = submitApprovalInputSchema;
export const mcpSubmitForApprovalResultSchema = submitApprovalResultSchema;
export const mcpGetApprovalStatusInputSchema = getApprovalStatusInputSchema;
export const mcpGetApprovalStatusResultSchema = getApprovalStatusResultSchema;
export const mcpGetConnectorStatusInputSchema = getConnectorStatusInputSchema;
export const mcpGetConnectorStatusResultSchema = getConnectorStatusResultSchema;
export const mcpGetSlaMetricsInputSchema = getSlaMetricsInputSchema;
export const mcpGetSlaMetricsResultSchema = getSlaMetricsResultSchema;
export const mcpProposalHandoffSchema = proposalHandoffSchema;

interface McpToolSchemaPair {
  readonly input: z.ZodType;
  readonly result: z.ZodType;
}

export const mcpToolSchemas = {
  list_pending_communications: {
    input: mcpListPendingInputSchema,
    result: mcpListPendingResultSchema,
  },
  get_communication: {
    input: mcpGetCommunicationInputSchema,
    result: mcpGetCommunicationResultSchema,
  },
  get_thread_context: {
    input: mcpGetThreadContextInputSchema,
    result: mcpGetThreadContextResultSchema,
  },
  search_knowledge: {
    input: mcpSearchKnowledgeInputSchema,
    result: mcpSearchKnowledgeResultSchema,
  },
  get_related_asana_work: {
    input: mcpGetRelatedAsanaWorkInputSchema,
    result: mcpGetRelatedAsanaWorkResultSchema,
  },
  recommend_action: {
    input: mcpRecommendActionInputSchema,
    result: mcpRecommendActionResultSchema,
  },
  create_draft: {
    input: mcpCreateDraftInputSchema,
    result: mcpCreateDraftResultSchema,
  },
  revise_draft: {
    input: mcpReviseDraftInputSchema,
    result: mcpReviseDraftResultSchema,
  },
  request_context: {
    input: mcpRequestContextInputSchema,
    result: mcpRequestContextResultSchema,
  },
  prepare_asana_action: {
    input: mcpPrepareAsanaActionInputSchema,
    result: mcpPrepareAsanaActionResultSchema,
  },
  submit_for_approval: {
    input: mcpSubmitForApprovalInputSchema,
    result: mcpSubmitForApprovalResultSchema,
  },
  get_approval_status: {
    input: mcpGetApprovalStatusInputSchema,
    result: mcpGetApprovalStatusResultSchema,
  },
  get_connector_status: {
    input: mcpGetConnectorStatusInputSchema,
    result: mcpGetConnectorStatusResultSchema,
  },
  get_sla_metrics: {
    input: mcpGetSlaMetricsInputSchema,
    result: mcpGetSlaMetricsResultSchema,
  },
} as const satisfies Record<McpToolName, McpToolSchemaPair>;

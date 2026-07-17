import { describe, expect, it } from 'vitest';

import { mcpToolNameSchema, mcpToolSchemas, type McpToolName } from './mcp.js';

const sha = 'a'.repeat(64);

const validInputs: Readonly<Record<McpToolName, Record<string, unknown>>> = {
  list_pending_communications: { limit: 20 },
  get_communication: { messageRevisionId: 'message-revision-a' },
  get_thread_context: { threadId: 'thread-a', limit: 20 },
  search_knowledge: {
    queryText: 'What changed?',
    exactEntityRefs: [],
    limit: 20,
  },
  get_related_asana_work: {
    messageRevisionId: 'message-revision-a',
    limit: 20,
  },
  recommend_action: {
    messageRevisionId: 'message-revision-a',
    expectedMessageRevision: 1,
  },
  create_draft: {
    recommendationId: 'recommendation-a',
    expectedRecommendationRevision: 1,
  },
  revise_draft: {
    draftRevisionId: 'draft-revision-a',
    expectedDraftRevision: 1,
    revisionInstruction: 'Make the response shorter.',
  },
  request_context: {
    recommendationId: 'recommendation-a',
    expectedRecommendationRevision: 1,
  },
  prepare_asana_action: {
    recommendationId: 'recommendation-a',
    expectedRecommendationRevision: 1,
  },
  submit_for_approval: {
    actionPlanId: 'action-plan-a',
    expectedActionPlanRevision: 1,
    actionPlanHash: sha,
  },
  get_approval_status: { proposalId: 'proposal-a' },
  get_connector_status: {},
  get_sla_metrics: { window: '24h' },
};

describe('MCP serialization registry', () => {
  it('has one strict input/result pair for every named tool', () => {
    expect(Object.keys(mcpToolSchemas).sort()).toEqual(
      [...mcpToolNameSchema.options].sort(),
    );
    for (const name of mcpToolNameSchema.options) {
      expect(
        mcpToolSchemas[name].input.safeParse(validInputs[name]).success,
      ).toBe(true);
      expect(mcpToolSchemas[name].result).toBeDefined();
    }
  });

  it.each(['actor', 'tenantId', 'accountId', 'brandId'] as const)(
    'rejects caller authority field %s for every tool',
    (forbiddenField) => {
      for (const name of mcpToolNameSchema.options) {
        expect(
          mcpToolSchemas[name].input.safeParse({
            ...validInputs[name],
            [forbiddenField]:
              forbiddenField === 'actor'
                ? { tenantId: 'tenant-a' }
                : `${forbiddenField}-a`,
          }).success,
        ).toBe(false);
      }
    },
  );
});

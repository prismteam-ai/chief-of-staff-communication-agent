import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  system: { health: { query: vi.fn() } },
  dashboard: { metrics: { query: vi.fn() }, sla: { query: vi.fn() } },
  communications: {
    list: { query: vi.fn() },
    get: { query: vi.fn() },
    thread: { query: vi.fn() },
  },
  connectors: { status: { query: vi.fn() } },
  work: { relatedAsana: { query: vi.fn() } },
  knowledge: { search: { query: vi.fn() } },
  agent: {
    recommend: { mutate: vi.fn() },
    createDraft: { mutate: vi.fn() },
    reviseDraft: { mutate: vi.fn() },
    requestContext: { mutate: vi.fn() },
  },
  approvals: {
    prepare: { mutate: vi.fn() },
    prepareAsana: { mutate: vi.fn() },
    status: { query: vi.fn() },
  },
  execution: { status: { query: vi.fn() } },
};

vi.mock('@chief/api-client', () => ({
  createApiClient: vi.fn(() => mockClient),
}));

import { createBrowserApi } from './index.js';

describe('browser API facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps effect-disabled execution status truthful', async () => {
    mockClient.execution.status.query.mockResolvedValue({
      proposalId: 'proposal_fixture_effect_disabled',
      runtimeMode: 'fixture',
      effectPolicy: 'effect_disabled',
      externalEffect: false,
      status: 'effect_disabled',
      receipt: {
        kind: 'effect_disabled',
        operationId: 'operation-fixture-no-effect',
        artifactHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stableIdempotencyKey: 'stable-fixture-key',
        observedAt: '2026-07-17T12:00:00.000Z',
      },
    });
    const api = createBrowserApi('https://chief.example.test');

    const status = await api.getExecutionStatus(
      'proposal_fixture_effect_disabled',
    );

    expect(status).toMatchObject({
      runtimeMode: 'fixture',
      externalEffect: false,
      status: 'effect_disabled',
    });
    expect(mockClient.execution.status.query).toHaveBeenCalledWith({
      proposalId: 'proposal_fixture_effect_disabled',
    });
  });

  it('passes only bounded product inputs and never injects tenant authority', async () => {
    mockClient.communications.list.query.mockResolvedValue({
      items: [],
    });
    const api = createBrowserApi('https://chief.example.test');

    await api.listCommunications({ status: 'pending', limit: 20 });

    expect(mockClient.communications.list.query).toHaveBeenCalledWith({
      status: 'pending',
      limit: 20,
    });
    expect(
      mockClient.communications.list.query.mock.calls[0]?.[0],
    ).not.toHaveProperty('tenantId');
    expect(
      mockClient.communications.list.query.mock.calls[0]?.[0],
    ).not.toHaveProperty('accountId');
  });
});

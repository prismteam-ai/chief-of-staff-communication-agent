import { describe, expect, it } from 'vitest';

import { apiRoutes, createApiClient } from './index.js';

describe('generated-style API client surface', () => {
  it('exposes every product route without direct external effects', () => {
    expect(apiRoutes).toMatchObject({
      communications: ['list', 'get', 'thread'],
      dashboard: ['metrics', 'sla'],
      approvals: ['prepare', 'prepareAsana', 'status'],
      execution: ['status'],
    });
    expect(JSON.stringify(apiRoutes)).not.toMatch(
      /sendMessage|approve|createTask|updateTask/iu,
    );
  });

  it('creates one typed proxy for the normalized tRPC base URL', () => {
    const client = createApiClient({
      baseUrl: 'https://chief.example.test/',
      headers: () => ({ 'x-client-version': 'fixture-test' }),
    });

    expect(typeof client.communications.list.query).toBe('function');
    expect(typeof client.agent.createDraft.mutate).toBe('function');
    expect(typeof client.execution.status.query).toBe('function');
  });
});

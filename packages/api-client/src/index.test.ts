import { describe, expect, it, vi } from 'vitest';

import {
  apiRoutes,
  BrowserApiNetworkError,
  BrowserAuthenticationRequiredError,
  createApiClient,
} from './index.js';

async function captureRejection(
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

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

  it('uses cookie credentials and never synthesizes browser authorization', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ result: { data: { json: {} } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient({
      baseUrl: 'https://chief.example.test',
      fetch: fetchMock,
    });

    await client.system.health.query();

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0];
    expect(request?.[1]).toMatchObject({ credentials: 'include' });
    expect(new Headers(request?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('fails closed when a caller attempts to add Authorization', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createApiClient({
      baseUrl: 'https://chief.example.test',
      fetch: fetchMock,
      headers: () => ({ Authorization: 'forbidden' }),
    });

    await expect(client.system.health.query()).rejects.toThrow(
      'BROWSER_AUTHORIZATION_HEADER_FORBIDDEN',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies 401 responses separately from transport failures', async () => {
    const unauthorized = createApiClient({
      baseUrl: 'https://chief.example.test',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
    });
    const offline = createApiClient({
      baseUrl: 'https://chief.example.test',
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')),
    });

    const unauthorizedFailure = await captureRejection(() =>
      unauthorized.system.health.query(),
    );
    const offlineFailure = await captureRejection(() =>
      offline.system.health.query(),
    );

    expect(unauthorizedFailure).toBeInstanceOf(Error);
    expect((unauthorizedFailure as Error).cause).toBeInstanceOf(
      BrowserAuthenticationRequiredError,
    );
    expect(offlineFailure).toBeInstanceOf(Error);
    expect((offlineFailure as Error).cause).toBeInstanceOf(
      BrowserApiNetworkError,
    );
  });
});

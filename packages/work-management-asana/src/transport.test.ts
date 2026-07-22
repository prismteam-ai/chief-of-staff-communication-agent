import { describe, expect, it } from 'vitest';
import { connectorAccountRefSchema } from '@chief/contracts/connectors';

import {
  ASANA_API_ORIGIN,
  ASANA_API_PREFIX,
  AsanaRestTransport,
  AsanaTransportError,
} from './transport.js';
import type { AsanaCredentialSource, AsanaRequest } from './types.js';

const account = connectorAccountRefSchema.parse({
  tenantId: 'tenant-a',
  accountId: 'account-a',
  expectedStateVersion: 1,
});

function credentials(secret = 'synthetic-test-pat'): AsanaCredentialSource {
  return {
    withBearerToken: (_account, use) => use(secret),
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function request(overrides: Partial<AsanaRequest> = {}): AsanaRequest {
  return {
    method: 'GET',
    path: '/users/me',
    account,
    ...overrides,
  };
}

describe('AsanaRestTransport', () => {
  it('hard-binds the API origin, keeps the PAT in the authorization header, and disables redirects', async () => {
    let observedUrl = '';
    let observedAuthorization = '';
    let observedRedirect: string | undefined;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      fetch: (input, init) => {
        observedUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        observedAuthorization =
          new Headers(init?.headers).get('authorization') ?? '';
        observedRedirect = init?.redirect;
        return Promise.resolve(jsonResponse({ data: { gid: '1' } }));
      },
    });
    await expect(
      transport.request(
        request({ query: { opt_fields: 'gid', workspace: '123' } }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    const url = new URL(observedUrl);
    expect(url.origin).toBe(ASANA_API_ORIGIN);
    expect(url.pathname).toBe(`${ASANA_API_PREFIX}/users/me`);
    expect(observedAuthorization).toBe('Bearer synthetic-test-pat');
    expect(observedRedirect).toBe('manual');
  });

  it('rejects arbitrary hosts, traversal, and redirects without following them', async () => {
    let calls = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          jsonResponse({}, 302, {
            location: 'https://attacker.invalid/capture',
          }),
        );
      },
    });
    for (const path of [
      'https://attacker.invalid/tasks',
      '/../tasks',
      '/tasks/%2e/users/me',
      '/tasks/%2E%2e/users/me',
      '/tasks/.%2E/users/me',
      '/tasks/%2e./users/me',
      '/tasks/%252e%252e/users/me',
      '/tasks/%2f%2fattacker.invalid',
      '/tasks\\..\\secrets',
    ]) {
      await expect(transport.request(request({ path }))).rejects.toMatchObject({
        code: 'ASANA_TRANSPORT_REQUEST_INVALID',
      });
    }
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_REDIRECT_REJECTED',
      status: 302,
    });
    expect(calls).toBe(1);
  });

  it('rejects sensitive query keys and a duplicated injected PAT before fetch', async () => {
    const secret = 'synthetic-pat-never-in-url';
    let calls = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(secret),
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ data: {} }));
      },
    });
    for (const key of [
      'access_token',
      'TOKEN',
      'authorization',
      'pat',
      'client_secret',
      'api_key',
    ]) {
      await expect(
        transport.request(request({ query: { [key]: 'synthetic-value' } })),
      ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
    }
    await expect(
      transport.request(request({ query: { q: secret } })),
    ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
    await expect(
      transport.request(
        request({ method: 'POST', path: '/tasks', body: { data: secret } }),
      ),
    ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
    await expect(
      transport.request(
        request({ headers: { 'if-unmodified-since': secret } }),
      ),
    ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
    expect(calls).toBe(0);
  });

  it('rejects unsupported caller-supplied headers before fetch', async () => {
    let calls = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ data: {} }));
      },
    });
    await expect(
      transport.request(
        request({
          method: 'PUT',
          path: '/tasks/9001',
          headers: {
            'if-unmodified-since': '2026-07-18T12:00:00.000Z',
          },
          body: { data: { name: 'approved-name' } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
    expect(calls).toBe(0);
  });

  it('rejects a punctuation-bearing PAT in original query input before URL serialization', async () => {
    const secret = "synthetic'pat-value";
    let calls = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(secret),
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ data: {} }));
      },
    });
    await expect(
      transport.request(request({ query: { q: `prefix-${secret}-suffix` } })),
    ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
    expect(calls).toBe(0);
  });

  it('rejects quote- or slash-bearing PATs in the original body before fetch', async () => {
    for (const secret of ['synthetic"quoted-pat', 'synthetic\\slashed-pat']) {
      let calls = 0;
      const transport = new AsanaRestTransport({
        credentials: credentials(secret),
        fetch: () => {
          calls += 1;
          return Promise.resolve(jsonResponse({ data: {} }));
        },
      });
      await expect(
        transport.request(
          request({ method: 'POST', path: '/tasks', body: { data: secret } }),
        ),
      ).rejects.toMatchObject({ code: 'ASANA_TRANSPORT_REQUEST_INVALID' });
      expect(calls).toBe(0);
    }
  });

  it('redacts credential and provider error text from transport failures', async () => {
    const secret = 'synthetic-secret-that-must-not-escape';
    const transport = new AsanaRestTransport({
      credentials: credentials(secret),
      fetch: () => Promise.reject(new Error(`provider echoed ${secret}`)),
    });
    let thrown: unknown;
    try {
      await transport.request(request());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AsanaTransportError);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(String(thrown)).toBe('AsanaTransportError: ASANA_TRANSPORT_FAILED');
  });

  it('drops a provider request ID that echoes the credential from errors, results, and evidence', async () => {
    const secret = 'synthetic-echoed-request-id-pat';
    const evidence: unknown[] = [];
    const redirect = new AsanaRestTransport({
      credentials: credentials(secret),
      fetch: () =>
        Promise.resolve(
          jsonResponse({}, 302, {
            location: 'https://app.asana.com/api/1.0/users/me',
            'x-request-id': secret,
          }),
        ),
    });
    let thrown: unknown;
    try {
      await redirect.request(request());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'ASANA_TRANSPORT_REDIRECT_REJECTED',
      requestId: undefined,
    });
    expect(JSON.stringify(thrown)).not.toContain(secret);

    const limited = new AsanaRestTransport({
      credentials: credentials(secret),
      evidence: { record: (item) => evidence.push(item) },
      fetch: () =>
        Promise.resolve(
          jsonResponse({}, 429, {
            'retry-after': '3',
            'x-request-id': secret,
          }),
        ),
    });
    const response = await limited.request(request());
    expect(response.headers).not.toHaveProperty('x-request-id');
    expect(evidence).toEqual([
      { method: 'GET', status: 429, retryAfterSeconds: 3 },
    ]);
    expect(JSON.stringify({ response, evidence })).not.toContain(secret);
  });

  it('accepts only bounded JSON response bodies', async () => {
    const nonJson = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () =>
        Promise.resolve(
          new Response('not-json', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
        ),
    });
    await expect(nonJson.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_CONTENT_TYPE_REJECTED',
    });

    const oversized = new AsanaRestTransport({
      credentials: credentials(),
      maxResponseBytes: 8,
      fetch: () => Promise.resolve(jsonResponse({ data: 'more-than-eight' })),
    });
    await expect(oversized.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_RESPONSE_TOO_LARGE',
    });
  });

  it('aborts at the fixed deadline and never retries', async () => {
    let calls = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      deadlineMilliseconds: 5,
      fetch: (_input, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('synthetic abort detail')),
            { once: true },
          );
        });
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    expect(calls).toBe(1);
  });

  it('applies the same deadline while the injected credential source is pending', async () => {
    let fetchCalls = 0;
    const transport = new AsanaRestTransport({
      credentials: {
        withBearerToken: () => new Promise(() => undefined),
      },
      deadlineMilliseconds: 5,
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(jsonResponse({ data: {} }));
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    expect(fetchCalls).toBe(0);
  });

  it('permits only one credential callback invocation and therefore one fetch', async () => {
    let fetchCalls = 0;
    const secret = 'synthetic-double-use-pat';
    const transport = new AsanaRestTransport({
      credentials: {
        withBearerToken: async (_account, use) => {
          const attempts = await Promise.all([use(secret), use(secret)]);
          return attempts[0];
        },
      },
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(jsonResponse({ data: { gid: '1' } }));
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_CREDENTIAL_INVALID',
    });
    expect(fetchCalls).toBe(1);
  });

  it('does not fetch when a deferred credential resolves after the deadline', async () => {
    let fetchCalls = 0;
    const transport = new AsanaRestTransport({
      credentials: {
        withBearerToken: (_account, use) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(use('synthetic-deferred-pat')), 20);
          }),
      },
      deadlineMilliseconds: 5,
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(jsonResponse({ data: {} }));
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchCalls).toBe(0);
  });

  it('ignores a fetch response that resolves after deadline without evidence or retry', async () => {
    const evidence: unknown[] = [];
    let fetchCalls = 0;
    let resolveFetch: ((response: Response) => void) | undefined;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      deadlineMilliseconds: 5,
      evidence: { record: (item) => evidence.push(item) },
      fetch: () => {
        fetchCalls += 1;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    resolveFetch?.(jsonResponse({ data: { gid: 'late' } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCalls).toBe(1);
    expect(evidence).toEqual([]);
  });

  it('cancels a late response body and records no evidence after deadline', async () => {
    const evidence: unknown[] = [];
    let bodyCancelled = 0;
    let deliveredChunks = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      deadlineMilliseconds: 5,
      evidence: { record: (item) => evidence.push(item) },
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              deliveredChunks += 1;
              try {
                controller.enqueue(Buffer.from('{"data":{"gid":"late"}}'));
              } catch {
                // Immediate cancellation closes a conforming stream before
                // the deliberately late producer attempts delivery.
              }
            }, 20);
          },
          cancel() {
            bodyCancelled += 1;
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deliveredChunks).toBe(1);
    expect(bodyCancelled).toBe(1);
    expect(evidence).toEqual([]);
  });

  it('cancels a body immediately at deadline even when it never yields', async () => {
    const evidence: unknown[] = [];
    let bodyCancelled = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      deadlineMilliseconds: 5,
      evidence: { record: (item) => evidence.push(item) },
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                bodyCancelled += 1;
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    expect(bodyCancelled).toBe(1);
    expect(evidence).toEqual([]);
  });

  it('rejects an already-aborted caller signal before fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(jsonResponse({ data: {} }));
      },
    });
    await expect(
      transport.request(request({ signal: controller.signal })),
    ).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
    expect(fetchCalls).toBe(0);
  });

  it('classifies a deadline during bounded body consumption as deadline exceeded', async () => {
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      deadlineMilliseconds: 5,
      fetch: (_input, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('{"data":'));
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('synthetic body abort detail')),
              { once: true },
            );
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    await expect(transport.request(request())).rejects.toMatchObject({
      code: 'ASANA_TRANSPORT_DEADLINE_EXCEEDED',
    });
  });

  it('surfaces structured 429 evidence and rejects unsafe request IDs', async () => {
    const evidence: unknown[] = [];
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      evidence: { record: (item) => evidence.push(item) },
      fetch: () =>
        Promise.resolve(
          jsonResponse({ errors: [{ message: 'limited' }] }, 429, {
            'retry-after': '37',
            'x-request-id': `unsafe-${'x'.repeat(200)}`,
          }),
        ),
    });
    const response = await transport.request(request());
    expect(response).toMatchObject({
      status: 429,
      headers: { 'retry-after': '37' },
    });
    expect(response.headers).not.toHaveProperty('x-request-id');
    expect(evidence).toEqual([
      { method: 'GET', status: 429, retryAfterSeconds: 37 },
    ]);
  });

  it('bounds create reconciliation and freezes duplicate or incomplete matches', async () => {
    const observedUrls: string[] = [];
    const pages = [
      jsonResponse(
        {
          data: [{ gid: '1001', name: 'marker-task' }],
          next_page: { offset: 'next' },
        },
        200,
      ),
      jsonResponse(
        {
          data: [{ gid: '1002', name: 'marker-task' }],
          next_page: null,
        },
        200,
      ),
    ];
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      fetch: (input) => {
        observedUrls.push(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        );
        return Promise.resolve(pages.shift()!);
      },
    });
    const result = await transport.reconcileEffect(account, {} as never, {
      kind: 'create_task',
      workspaceGid: 'workspace-1',
      projectGid: 'project-1',
      fields: { name: 'marker-task' },
    });
    expect(result).toEqual({
      outcome: 'unknown',
      reasonCode: 'asana_create_reconciliation_ambiguous',
    });
    expect(
      observedUrls.every(
        (value) =>
          new URL(value).searchParams.get('completed_since') ===
          '1970-01-01T00:00:00.000Z',
      ),
    ).toBe(true);
  });

  it('freezes create reconciliation on malformed envelopes and pagination', async () => {
    for (const body of [
      {},
      { data: {}, next_page: null },
      { data: [null], next_page: null },
      { data: [{ gid: '1001' }], next_page: null },
      {
        data: [{ gid: 'not-a-provider-gid', name: 'marker-task' }],
        next_page: null,
      },
      { data: [], next_page: {} },
      { data: [], next_page: { offset: '' } },
      { data: [] },
    ]) {
      const transport = new AsanaRestTransport({
        credentials: credentials(),
        fetch: () => Promise.resolve(jsonResponse(body)),
      });
      await expect(
        transport.reconcileEffect(account, {} as never, {
          kind: 'create_task',
          workspaceGid: '1001',
          projectGid: '2001',
          fields: { name: 'marker-task' },
        }),
      ).resolves.toEqual({
        outcome: 'unknown',
        reasonCode: 'asana_create_reconciliation_invalid_page',
      });
    }
  });

  it('freezes create reconciliation when bounded coverage cannot prove uniqueness', async () => {
    const atItemBound = Array.from({ length: 100 }, (_, index) => ({
      gid: String(index + 1),
      name: index === 0 ? 'marker-task' : 'other-task',
    }));
    const bounded = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            data: atItemBound,
            next_page: { offset: 'more' },
          }),
        ),
    });
    await expect(
      bounded.reconcileEffect(account, {} as never, {
        kind: 'create_task',
        workspaceGid: '1001',
        projectGid: '2001',
        fields: { name: 'marker-task' },
      }),
    ).resolves.toEqual({
      outcome: 'unknown',
      reasonCode: 'asana_create_reconciliation_incomplete',
    });

    const overrun = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            data: Array.from({ length: 101 }, (_, index) => ({
              gid: String(index + 1),
              name: 'other-task',
            })),
            next_page: null,
          }),
        ),
    });
    await expect(
      overrun.reconcileEffect(account, {} as never, {
        kind: 'create_task',
        workspaceGid: '1001',
        projectGid: '2001',
        fields: { name: 'marker-task' },
      }),
    ).resolves.toEqual({
      outcome: 'unknown',
      reasonCode: 'asana_create_reconciliation_page_overrun',
    });

    const cycle = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () =>
        Promise.resolve(
          jsonResponse({ data: [], next_page: { offset: 'same-offset' } }),
        ),
    });
    await expect(
      cycle.reconcileEffect(account, {} as never, {
        kind: 'create_task',
        workspaceGid: '1001',
        projectGid: '2001',
        fields: { name: 'marker-task' },
      }),
    ).resolves.toEqual({
      outcome: 'unknown',
      reasonCode: 'asana_create_reconciliation_offset_cycle',
    });
  });

  it('requires update reconciliation to bind the provider response GID', async () => {
    const transport = new AsanaRestTransport({
      credentials: credentials(),
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            data: {
              gid: '9999',
              name: 'approved-name',
              modified_at: '2026-07-18T12:01:00.000Z',
            },
          }),
        ),
    });
    await expect(
      transport.reconcileEffect(account, {} as never, {
        kind: 'update_task',
        taskGid: '9001',
        fields: { name: 'approved-name' },
        precondition: { modifiedAt: '2026-07-18T12:00:00.000Z' },
      }),
    ).resolves.toEqual({
      outcome: 'unknown',
      reasonCode: 'asana_update_reconciliation_invalid',
    });
  });
});

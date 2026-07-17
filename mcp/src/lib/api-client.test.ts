import { describe, expect, it, vi } from 'vitest';
import { createMcpApiClient, McpApiError } from './api-client.js';

/**
 * Coverage for the MCP server's tRPC HTTP client: every call carries the bearer token (never a
 * client-supplied userId — brief constraint 3), query vs mutation wire shape matches the deployed
 * Lambda's tRPC adapter contract, and an error envelope / non-2xx status surfaces as `McpApiError`
 * (what tool handlers turn into a clear MCP tool error rather than swallowing).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createMcpApiClient — query', () => {
  it('sends a GET with the input JSON-encoded in the querystring and the bearer token header', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ result: { data: { hits: [] } } });
    }) as unknown as typeof fetch;

    const client = createMcpApiClient({
      baseUrl: 'https://api.example.com/',
      token: 'cos_mcp_abc123',
      fetchImpl,
    });

    const result = await client.query('retrieveContext', { accountId: 'acct-1', query: 'reorg' });

    expect(result).toEqual({ hits: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.example.com/mcp.retrieveContext?input=' +
        encodeURIComponent(JSON.stringify({ accountId: 'acct-1', query: 'reorg' })),
    );
    expect(calls[0]?.init?.method).toBe('GET');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer cos_mcp_abc123');
  });

  it('throws McpApiError on an error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'MCP token is invalid, revoked, or unknown.' } }, 401),
    ) as unknown as typeof fetch;
    const client = createMcpApiClient({
      baseUrl: 'https://api.example.com',
      token: 'bad',
      fetchImpl,
    });

    await expect(client.query('retrieveContext', {})).rejects.toBeInstanceOf(McpApiError);
  });
});

describe('createMcpApiClient — mutate', () => {
  it('sends a POST with a JSON body and the bearer token header', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ result: { data: { commId: 'comm-1', status: 'answered' } } });
    }) as unknown as typeof fetch;

    const client = createMcpApiClient({
      baseUrl: 'https://api.example.com',
      token: 'cos_mcp_abc123',
      fetchImpl,
    });

    const result = await client.mutate('approveDraft', { commId: 'comm-1' });

    expect(result).toEqual({ commId: 'comm-1', status: 'answered' });
    expect(calls[0]?.url).toBe('https://api.example.com/mcp.approveDraft');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ commId: 'comm-1' }));
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer cos_mcp_abc123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('SECURITY: a 401 (forged/unknown/revoked token) surfaces as McpApiError, not a silent empty result', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: 'MCP token is invalid, revoked, or unknown.', code: 'UNAUTHORIZED' } },
        401,
      ),
    ) as unknown as typeof fetch;
    const client = createMcpApiClient({
      baseUrl: 'https://api.example.com',
      token: 'forged',
      fetchImpl,
    });

    await expect(client.mutate('approveDraft', { commId: 'comm-1' })).rejects.toThrow(
      /invalid, revoked, or unknown/,
    );
  });
});

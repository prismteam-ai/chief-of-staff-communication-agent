import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPidgeotMcpServer } from './create-server.js';

/**
 * End-to-end MCP protocol test (Task 11 brief constraint 7: "@modelcontextprotocol/sdk's
 * in-memory transport for an integration test"): a real `Client` talks to a real `McpServer` over
 * `InMemoryTransport.createLinkedPair()` — proving tool registration, JSON-RPC round-tripping, and
 * zod input validation all actually work, not just that the handler functions do in isolation. The
 * HTTP layer underneath is a fake `fetch` (no real network/AWS), same isolation as the unit tests.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function connectedClient(fetchImpl: typeof fetch) {
  const server = createPidgeotMcpServer({
    apiUrl: 'https://api.example.com',
    apiToken: 'cos_mcp_test-token',
    fetchImpl,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!('content' in result)) throw new Error('expected a content-bearing tool result');
  const content = result.content as { type: string; text: string }[];
  const first = content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

describe('pidgeot MCP server — end-to-end over InMemoryTransport', () => {
  it('lists all six tools required by the brief', async () => {
    const { client } = await connectedClient((async () =>
      jsonResponse({ result: { data: {} } })) as unknown as typeof fetch);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'approveDraft',
        'draftReply',
        'manageAsana',
        'recommendAction',
        'retrieveContext',
        'supplyContext',
      ].sort(),
    );
  });

  it('retrieveContext round-trips a real call through the (faked) hosted API', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      requestedUrls.push(url.toString());
      return jsonResponse({
        result: {
          data: {
            hits: [
              {
                chunkId: 'c1',
                sourceId: 's1',
                textForContext: 'hi',
                score: 0.9,
                channel: 'gmail',
                sourceType: 'communication',
              },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;
    const { client } = await connectedClient(fetchImpl);

    const result = await client.callTool({
      name: 'retrieveContext',
      arguments: { accountId: 'acct-1', query: 'reorg' },
    });

    expect(requestedUrls[0]).toContain('/mcp.retrieveContext?input=');
    const parsed = JSON.parse(textOf(result)) as { hits: unknown[] };
    expect(parsed.hits).toHaveLength(1);
  });

  it('approveDraft WITHOUT confirm never reaches the fetch layer at all (confirm-gate proof at the protocol boundary)', async () => {
    let fetchCallCount = 0;
    const fetchImpl = (async () => {
      fetchCallCount += 1;
      return jsonResponse({ result: { data: { commId: 'comm-1', sentMessageId: 'sent-1' } } });
    }) as unknown as typeof fetch;
    const { client } = await connectedClient(fetchImpl);

    const result = await client.callTool({ name: 'approveDraft', arguments: { commId: 'comm-1' } });

    expect(fetchCallCount).toBe(0);
    const parsed = JSON.parse(textOf(result)) as { status: string };
    expect(parsed.status).toBe('preview');
  });

  it('approveDraft WITH confirm: true reaches the hosted send path exactly once', async () => {
    let fetchCallCount = 0;
    const fetchImpl = (async () => {
      fetchCallCount += 1;
      return jsonResponse({ result: { data: { commId: 'comm-1', sentMessageId: 'sent-1' } } });
    }) as unknown as typeof fetch;
    const { client } = await connectedClient(fetchImpl);

    const result = await client.callTool({
      name: 'approveDraft',
      arguments: { commId: 'comm-1', confirm: true },
    });

    expect(fetchCallCount).toBe(1);
    const parsed = JSON.parse(textOf(result)) as { status: string };
    expect(parsed.status).toBe('sent');
  });

  it('SECURITY: a 401 from the hosted API (forged/rejected token) surfaces as a tool error, not a fabricated success', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: { message: 'MCP token is invalid, revoked, or unknown.' } },
        401,
      )) as unknown as typeof fetch;
    const { client } = await connectedClient(fetchImpl);

    const result = await client.callTool({
      name: 'recommendAction',
      arguments: { commId: 'comm-1' },
    });

    expect(result.isError).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { handler } from './handler.js';

function event(method: string, rawPath: string) {
  return {
    rawPath,
    requestContext: { http: { method } },
  } as never;
}

describe('foundation MCP handler', () => {
  it('reports health', () => {
    const result = handler(event('GET', '/mcp/health'));

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('truthfully rejects non-health requests', () => {
    const result = handler(event('POST', '/mcp'));
    const response = result as { body: string; statusCode: number };

    expect(response.statusCode).toBe(501);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'MCP_FOUNDATION_ONLY',
      foundationOnly: true,
    });
  });
});

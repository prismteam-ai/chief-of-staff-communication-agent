import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import {
  foundationOnlyErrorSchema,
  healthResponseSchema,
} from '@chief/contracts';

import { handler } from './handler.js';

function event(method: string, rawPath: string) {
  return {
    rawPath,
    requestContext: { http: { method } },
  } as never;
}

describe('foundation MCP handler', () => {
  it('immediately returns a Promise and reports health', async () => {
    const pendingResponse = handler(event('GET', '/mcp/health'));

    expect(pendingResponse).toBeInstanceOf(Promise);

    const response =
      (await pendingResponse) as APIGatewayProxyStructuredResultV2;
    const parsedBody: unknown = JSON.parse(response.body ?? '{}');
    const body = healthResponseSchema.parse(parsedBody);

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      service: 'chief-mcp',
      status: 'ok',
      timestamp: body.timestamp,
      foundationOnly: true,
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('truthfully rejects non-health requests', async () => {
    const response = (await handler(
      event('POST', '/mcp'),
    )) as APIGatewayProxyStructuredResultV2;

    const parsedBody: unknown = JSON.parse(response.body ?? '{}');

    expect(response.statusCode).toBe(501);
    expect(foundationOnlyErrorSchema.parse(parsedBody)).toEqual({
      code: 'MCP_FOUNDATION_ONLY',
      message: 'Remote MCP tools are not implemented in COS-010.',
      foundationOnly: true,
    });
  });
});

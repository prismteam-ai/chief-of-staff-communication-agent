import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

import { createObservability } from '@chief/observability';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { createDefaultMcpProductAdapter } from './product-service-adapter.js';
import { createMcpServer } from './server.js';
import type { McpRequestScope, McpToolService } from './service.js';
import { MCP_DEFAULT_TOOL_TIMEOUT_MS, MCP_MAX_BODY_BYTES } from './service.js';

const observability = createObservability('chief-mcp');
const defaultAdapter = createDefaultMcpProductAdapter(process.env);

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function jsonRpcError(
  statusCode: number,
  code: number,
  message: string,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code, message },
    }),
  };
}

function requestBody(event: APIGatewayProxyEventV2): Uint8Array {
  const raw = event.body ?? '';
  return event.isBase64Encoded
    ? Buffer.from(raw, 'base64')
    : Buffer.from(raw, 'utf8');
}

function requestUrl(event: APIGatewayProxyEventV2): string {
  const host = event.headers.host ?? 'chief-mcp.example.invalid';
  return `https://${host}${event.rawPath}`;
}

function requestHeaders(event: APIGatewayProxyEventV2): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined && name.toLowerCase() !== 'content-length') {
      result.set(name, value);
    }
  }
  return result;
}

async function toApiGatewayResponse(
  response: Response,
): Promise<APIGatewayProxyResultV2> {
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: await response.text(),
  };
}

export function createHandler(options?: {
  readonly service?: McpToolService;
  readonly scope?: McpRequestScope;
  readonly timeoutMs?: number;
}) {
  const service = options?.service ?? defaultAdapter.service;
  const scope = options?.scope ?? defaultAdapter.scope;
  const timeoutMs = options?.timeoutMs ?? MCP_DEFAULT_TOOL_TIMEOUT_MS;

  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyResultV2> => {
    if (
      event.requestContext.http.method === 'GET' &&
      event.rawPath.endsWith('/health')
    ) {
      observability.logger.info('MCP health requested');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          service: 'chief-mcp',
          status: 'ok',
          protocol: 'mcp-streamable-http',
          externalEffects: 'disabled',
          tenantSelection: 'server',
        }),
      };
    }

    if (event.rawQueryString) {
      return jsonRpcError(400, -32_600, 'Query parameters are not accepted.');
    }
    const body = requestBody(event);
    if (body.byteLength > MCP_MAX_BODY_BYTES) {
      return jsonRpcError(413, -32_600, 'Request body exceeds the limit.');
    }

    const method = event.requestContext.http.method;
    const request = new Request(requestUrl(event), {
      method,
      headers: requestHeaders(event),
      ...(method === 'POST' ? { body } : {}),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer({ service, scope, timeoutMs });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      return await toApiGatewayResponse(response);
    } catch {
      observability.logger.error('MCP transport failed', {
        errorCode: 'MCP_TRANSPORT_FAILED',
      });
      return jsonRpcError(500, -32_603, 'Internal MCP transport error.');
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}

export const handler = createHandler();

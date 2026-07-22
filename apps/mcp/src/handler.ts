import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

import { createObservability } from '@chief/observability';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { RequestAuthorityError } from '@chief/api';

import {
  createDefaultMcpAdapterResolver,
  type McpAdapterResolver,
} from './product-service-adapter.js';
import { createMcpServer } from './server.js';
import { MCP_DEFAULT_TOOL_TIMEOUT_MS, MCP_MAX_BODY_BYTES } from './service.js';

const observability = createObservability('chief-mcp');
const defaultAdapterResolver = createDefaultMcpAdapterResolver(process.env);

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

function authorityError(error: RequestAuthorityError): APIGatewayProxyResultV2 {
  const unauthorized = error.kind === 'unauthorized';
  return {
    statusCode: unauthorized ? 401 : 403,
    headers: {
      ...headers,
      ...(unauthorized
        ? { 'www-authenticate': 'Bearer realm="chief-mcp"' }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: unauthorized ? -32_001 : -32_003,
        message: unauthorized
          ? 'Authentication is required.'
          : 'The request is not permitted.',
      },
    }),
  };
}

function hasCookieHeader(
  values: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.keys(values).some(
    (name) => name.toLocaleLowerCase('en-US') === 'cookie',
  );
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
  readonly adapterResolver?: McpAdapterResolver;
  readonly healthCheck?: () => Promise<void>;
  readonly timeoutMs?: number;
}) {
  const adapterResolver = options?.adapterResolver ?? defaultAdapterResolver;
  const healthCheck = options?.healthCheck ?? (() => Promise.resolve());
  const timeoutMs = options?.timeoutMs ?? MCP_DEFAULT_TOOL_TIMEOUT_MS;

  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyResultV2> => {
    if (
      event.requestContext.http.method === 'GET' &&
      event.rawPath === '/mcp/health'
    ) {
      observability.logger.info('MCP health requested');
      try {
        await healthCheck();
      } catch {
        observability.logger.error('MCP readiness failed', {
          errorCode: 'MCP_READINESS_FAILED',
        });
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            service: 'chief-mcp',
            status: 'unavailable',
            protocol: 'mcp-streamable-http',
            externalEffects: 'disabled',
            tenantSelection: 'server',
          }),
        };
      }
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

    if (
      hasCookieHeader(event.headers) ||
      (event.cookies !== undefined && event.cookies.length > 0)
    ) {
      return authorityError(
        new RequestAuthorityError('unauthorized', 'invalid_session'),
      );
    }

    let adapter;
    try {
      adapter = await adapterResolver.resolve({
        headers: event.headers,
        method: event.requestContext.http.method,
      });
    } catch (error) {
      if (error instanceof RequestAuthorityError) {
        observability.logger.warn('MCP request authority rejected', {
          errorKind: error.kind,
        });
        return authorityError(error);
      }
      observability.logger.error('MCP request authority failed', {
        errorCode: 'MCP_AUTHORITY_FAILED',
      });
      return jsonRpcError(500, -32_603, 'Internal MCP transport error.');
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
    const server = createMcpServer({
      service: adapter.service,
      scope: adapter.scope,
      timeoutMs,
    });
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

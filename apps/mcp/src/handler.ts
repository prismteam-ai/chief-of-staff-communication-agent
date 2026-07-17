import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

import {
  createHealthResponse,
  foundationOnlyErrorSchema,
} from '@chief/contracts';
import { createObservability } from '@chief/observability';

const observability = createObservability('chief-mcp');

const headers = {
  'content-type': 'application/json; charset=utf-8',
};

// The managed Lambda runtime requires a Promise-returning handler contract.
// eslint-disable-next-line @typescript-eslint/require-await
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  if (
    event.requestContext.http.method === 'GET' &&
    event.rawPath.endsWith('/health')
  ) {
    observability.logger.info('Foundation health requested');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(createHealthResponse('chief-mcp')),
    };
  }

  observability.logger.warn('MCP request rejected by foundation boundary');
  return {
    statusCode: 501,
    headers,
    body: JSON.stringify(
      foundationOnlyErrorSchema.parse({
        code: 'MCP_FOUNDATION_ONLY',
        message: 'Remote MCP tools are not implemented in COS-010.',
        foundationOnly: true,
      }),
    ),
  };
}

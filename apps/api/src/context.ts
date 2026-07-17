import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CreateAWSLambdaContextOptions } from '@trpc/server/adapters/aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics } from '@aws-lambda-powertools/metrics';

export const SERVICE_NAME = 'chief-of-staff-api';

export const logger = new Logger({ serviceName: SERVICE_NAME });
export const tracer = new Tracer({ serviceName: SERVICE_NAME });
export const metrics = new Metrics({
  serviceName: SERVICE_NAME,
  namespace: 'ChiefOfStaffApi',
});

/** Extracts a `Bearer <token>` from the `Authorization` header — case-insensitive header lookup
 * since API Gateway HTTP APIs (v2) lower-case header names but a local/test harness may not. */
function extractBearerToken(headers: APIGatewayProxyEventV2['headers']): string | undefined {
  const raw = headers?.['authorization'] ?? headers?.['Authorization'];
  if (!raw) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || undefined;
}

export const createContext = ({
  event,
  context,
}: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>) => ({
  event,
  context,
  logger,
  tracer,
  metrics,
  /** Bearer token from the `Authorization` header — `undefined` for a request with none. Shared by
   * BOTH the MCP server (Task 11) and the dashboard's own browser calls (Task 8.5: the dashboard
   * used to trust a client-supplied `userId` with no token at all; it now authenticates the exact
   * same way MCP does — see `services/dashboard-authed-middleware.ts`). One extraction, one
   * `McpAuthService.verify` call, two router surfaces (`routers/mcp.ts`, every dashboard-facing
   * router) that both require it and both resolve `userId` from the verified token, never from
   * client input. */
  bearerToken: extractBearerToken(event.headers),
});

export type Context = Awaited<ReturnType<typeof createContext>>;

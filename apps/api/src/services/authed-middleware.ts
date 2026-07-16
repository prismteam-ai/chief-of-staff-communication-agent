import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { McpTokenInvalidError } from '@chief-of-staff/shared';
import { TRPCError } from '@trpc/server';
import { middleware } from '../trpc.js';
import { metrics } from '../context.js';
import type { McpAuthService } from './mcp-auth-service.js';

/**
 * Shared bearer-token authentication gate (Task 11 + Task 8.5): resolves `ctx.bearerToken` to a
 * verified `userId` via `McpAuthService.verify` — the SAME check for the MCP server's tool calls
 * and the dashboard's own tRPC calls, because as of Task 8.5 both present the identical
 * `Authorization: Bearer <token>` header and are checked against the identical token table. A
 * missing header or an invalid/forged/revoked token is rejected with `UNAUTHORIZED` before any
 * procedure body runs, in both cases — there is no "trust the client's userId" fallback anywhere
 * downstream of this middleware.
 *
 * `metricName` lets each call site record its own processed-count metric (`McpToolInvoked` for
 * MCP, `DashboardRequestAuthenticated` for the dashboard) on the SAME dashboard-visible axis every
 * other per-surface counter in this codebase uses, while the failure path always emits the shared
 * `McpAuthFailed` counter — a rejected token is a rejected token regardless of which surface
 * presented it.
 */
export function authedMiddleware(getAuthService: () => McpAuthService, metricName: string) {
  return middleware(async ({ ctx, next }) => {
    const bearerToken = (ctx as { bearerToken?: string }).bearerToken;
    if (!bearerToken) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Missing Authorization: Bearer <token> header.',
      });
    }
    let userId: string;
    try {
      userId = await getAuthService().verify(bearerToken);
    } catch (error) {
      if (error instanceof McpTokenInvalidError) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
      }
      throw error;
    }
    metrics.addMetric(metricName, MetricUnit.Count, 1);
    return next({ ctx: { ...ctx, authedUserId: userId } });
  });
}

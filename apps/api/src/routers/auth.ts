import {
  DashboardLoginInputSchema,
  DashboardLoginResultSchema,
  DashboardLoginInvalidError,
} from '@chief-of-staff/shared';
import { TRPCError } from '@trpc/server';
import { publicProcedure, router } from '../trpc.js';
import { DashboardLoginService } from '../services/dashboard-login-service.js';

/**
 * Dashboard authentication tRPC router (Task 8.5): the ONE unauthenticated procedure a browser
 * calls before it has a token. `login` verifies a username/password against the operator-
 * provisioned demo credential (`DashboardLoginService`) and, on success, mints a session token via
 * the exact same `McpAuthService.issue` Task 11 built for MCP tokens. Every other dashboard-facing
 * router (`communications`, `metrics`, `accounts`, `asana`) now requires the token this returns —
 * see `services/authed-middleware.ts`.
 *
 * `DashboardLoginInvalidError` is translated to `TRPCError({code:'UNAUTHORIZED'})` here — the same
 * "domain error -> TRPCError at the router boundary" translation `authed-middleware.ts` does for
 * `McpTokenInvalidError` — so a bad credential surfaces as a real 401 the frontend's `TrpcError
 * .isUnauthorized` check (and any API consumer) can rely on, not a generic 500.
 */
export function createAuthRouter(getService: () => DashboardLoginService) {
  return router({
    login: publicProcedure
      .input(DashboardLoginInputSchema)
      .output(DashboardLoginResultSchema)
      .mutation(async ({ input }) => {
        try {
          return await getService().login(input);
        } catch (error) {
          if (error instanceof DashboardLoginInvalidError) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
          }
          throw error;
        }
      }),
  });
}

import { DashboardLoginInputSchema, DashboardLoginResultSchema } from '@chief-of-staff/shared';
import { publicProcedure, router } from '../trpc.js';
import { DashboardLoginService } from '../services/dashboard-login-service.js';

/**
 * Dashboard authentication tRPC router (Task 8.5): the ONE unauthenticated procedure a browser
 * calls before it has a token. `login` verifies a username/password against the operator-
 * provisioned demo credential (`DashboardLoginService`) and, on success, mints a session token via
 * the exact same `McpAuthService.issue` Task 11 built for MCP tokens. Every other dashboard-facing
 * router (`communications`, `metrics`, `accounts`, `asana`) now requires the token this returns —
 * see `services/authed-middleware.ts`.
 */
export function createAuthRouter(getService: () => DashboardLoginService) {
  return router({
    login: publicProcedure
      .input(DashboardLoginInputSchema)
      .output(DashboardLoginResultSchema)
      .mutation(({ input }) => getService().login(input)),
  });
}

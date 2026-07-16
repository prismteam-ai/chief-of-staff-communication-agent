import { initTRPC, TRPCError } from '@trpc/server';
import { AccountAccessDeniedError } from '@chief-of-staff/shared';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;

/**
 * Global domain-error -> TRPCError mapping, applied to every procedure via `publicProcedure` below
 * (routers layer this under their own `authedMiddleware`, or use it directly for the few
 * unauthenticated procedures like `auth.login`/`mcp.issueMcpToken`). Before this middleware existed,
 * `AccountAccessDeniedError` (`packages/shared/src/permissions.ts`, thrown by the `assertAccountAccess`
 * guard every service — `ApprovalService`, `AsanaService`, `MetricsService`, `routers/mcp.ts`'s
 * `retrieveContext` — calls before touching another user's account) propagated out of the procedure
 * as a plain `Error`. tRPC's `awsLambdaRequestHandler` normalizes any thrown value that isn't already
 * a `TRPCError` to `INTERNAL_SERVER_ERROR`, i.e. HTTP 500 — so a cross-account access attempt (a
 * legitimate, expected authorization outcome) was indistinguishable from a genuine server bug both to
 * an API consumer's status-code branching and to on-call reading CloudWatch. Mapped to `FORBIDDEN`
 * (403): the caller IS authenticated (`authedMiddleware` already ran and resolved a real `userId`)
 * but is not authorized for the specific account — the textbook 403 case, distinct from the 401s
 * `auth.ts`/`authed-middleware.ts` already return for a missing/invalid token.
 *
 * Centralized here rather than duplicated as a try/catch in every router procedure (the
 * pre-existing pattern `auth.ts`'s `login` and `authed-middleware.ts` use for
 * `DashboardLoginInvalidError`/`McpTokenInvalidError`) so a new call site of `assertAccountAccess`
 * never has to remember to add its own translation — it inherits this for free by building on
 * `publicProcedure`.
 */
const domainErrorMappingMiddleware = t.middleware(async ({ next }) => {
  // NOTE: `next()` does NOT reject when a downstream middleware/resolver throws — tRPC v11's
  // `callRecursive` catches that internally and RESOLVES `next()` with `{ ok: false, error }`
  // (see `procedureBuilder.ts`; only the outermost `createProcedureCaller` unwraps that into an
  // actual throw). A `try { await next() } catch { ... }` here would therefore never run: it looks
  // like it should catch the downstream error but silently never does, and the raw
  // `AccountAccessDeniedError` sails through unmapped. Must inspect `result.ok` instead.
  const result = await next();
  if (!result.ok && result.error.cause instanceof AccountAccessDeniedError) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: result.error.cause.message,
      cause: result.error.cause,
    });
  }
  return result;
});

export const publicProcedure = t.procedure.use(domainErrorMappingMiddleware);

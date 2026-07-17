import { initTRPC, TRPCError } from '@trpc/server';
import { AccountAccessDeniedError } from '@chief-of-staff/shared';
import type { Context } from './context.js';

/**
 * Production stack-trace suppression (slowking fix 3, information disclosure): checked LIVE on
 * every response rather than captured once at module load, so `NODE_ENV`/the explicit fallback
 * flag can be toggled per-test without a module-reset dance. `NODE_ENV=production` is the primary
 * signal (set on the deployed API Lambda — `lib/stacks/api-stack.ts`); `API_SUPPRESS_ERROR_DETAILS`
 * is an explicit escape hatch for any runtime where setting `NODE_ENV` isn't practical. Local dev
 * and `vitest`/CI runs leave both unset, so `errorFormatter` below stays a no-op and every existing
 * test that inspects `TRPCError`s directly is unaffected.
 */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.API_SUPPRESS_ERROR_DETAILS === 'true';
}

const t = initTRPC.context<Context>().create({
  /**
   * (slowking fix 3) 401/403/404/etc. responses were leaking full server stack traces —
   * `/apps/api/src/...` source paths included, since `NODE_OPTIONS=--enable-source-maps`
   * (api-stack.ts) rewrites Lambda stack traces back to original TS source — because tRPC's
   * default `getErrorShape` attaches `shape.data.stack` whenever `isDev` is true, and the deployed
   * Lambda never set `NODE_ENV`, so tRPC's own `isDev` default (`NODE_ENV !== 'production'`)
   * resolved to `true` in production. This formatter is the actual enforcement point: it strips
   * `stack` (and, belt-and-suspenders, scrubs any leftover repo-path substring out of `message`)
   * whenever `isProductionRuntime()` is true, regardless of what `isDev` resolved to — every
   * production response then carries `code` + a safe `message` only. Dev/CI/test stay fully
   * verbose (this is a no-op there), matching "Keep dev verbose".
   */
  errorFormatter(opts) {
    const { shape } = opts;
    if (!isProductionRuntime()) return shape;
    const { stack: _stack, ...safeData } = shape.data;
    return {
      ...shape,
      message: scrubRepoPaths(shape.message),
      data: safeData,
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;

/** Removes any `/apps/api/src/...`-shaped repo path that might have leaked into an error
 * `message` outside the dedicated (already-stripped) `stack` field — e.g. a thrown filesystem
 * error whose own `.message` embeds an absolute path. */
function scrubRepoPaths(message: string): string {
  return message.replace(/\S*\/apps\/api\/src\/\S*/g, '[redacted]');
}

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

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, Context as LambdaContext } from 'aws-lambda';
import { TRPCError } from '@trpc/server';
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda';
import { router, publicProcedure } from './trpc.js';
import { createContext } from './context.js';

/**
 * Production stack-trace suppression (slowking fix 3, information disclosure): drives a REAL
 * `awsLambdaRequestHandler(...)` — the same adapter `handler.ts` wires the actual `appRouter`
 * through — over a tiny throwing procedure built on the SAME `router`/`publicProcedure` exports
 * every real router uses, so this exercises the actual `errorFormatter`/`isDev` mechanism in
 * `trpc.ts`, not a reimplementation of it. `router.createCaller(ctx)` (the pattern every other
 * `*.integration.test.ts` in this directory uses) bypasses this entirely — it calls the procedure
 * in-process and rethrows the raw `TRPCError`, never running it through `getErrorShape`/
 * `errorFormatter`, so it can't prove what the actual HTTP response body contains.
 */

const testRouter = router({
  // Simulates a real failure whose message happens to embed a repo-relative source path (e.g. a
  // downstream error's own `.message` bubbling up) — proves the belt-and-suspenders `message`
  // scrub, not just the dedicated `stack` field.
  throwsForbidden: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cross-account read denied at /apps/api/src/services/metrics-service.ts:139:5',
    });
  }),
});

const testHandler = awsLambdaRequestHandler({ router: testRouter, createContext });

function queryEvent(procedure: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `GET /${procedure}`,
    rawPath: `/${procedure}`,
    rawQueryString: '',
    headers: {},
    requestContext: {
      domainName: 'example.com',
      http: { method: 'GET' },
    } as APIGatewayProxyEventV2['requestContext'],
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

interface ErrorEnvelope {
  error: { message: string; code: number; data: Record<string, unknown> };
}

async function invoke(procedure: string): Promise<ErrorEnvelope> {
  const result = await testHandler(queryEvent(procedure), {} as LambdaContext);
  return JSON.parse(result.body ?? '{}') as ErrorEnvelope;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trpc error responses — production stack-trace suppression (slowking fix 3)', () => {
  it('dev/test (NODE_ENV unset) stays verbose — the mechanism baseline this fix must not break', async () => {
    // No stubbing: vitest's own NODE_ENV ("test") — proves the counterfactual, i.e. that
    // isProductionRuntime() is actually gating something rather than always stripping.
    const body = await invoke('throwsForbidden');

    expect(body.error.data['code']).toBe('FORBIDDEN');
    expect(typeof body.error.data['stack']).toBe('string');
  });

  it('NODE_ENV=production strips the stack trace and any /apps/api/src path from the response body', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const body = await invoke('throwsForbidden');

    expect(body.error.data['code']).toBe('FORBIDDEN');
    expect(body.error.data['stack']).toBeUndefined();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('/apps/api/src');
    // Code + a safe message only — the client can still branch on the FORBIDDEN code.
    expect(body.error.message).not.toContain('/apps/api/src');
  });

  it('the explicit API_SUPPRESS_ERROR_DETAILS flag also strips details (escape hatch for runtimes that cannot set NODE_ENV)', async () => {
    vi.stubEnv('API_SUPPRESS_ERROR_DETAILS', 'true');

    const body = await invoke('throwsForbidden');

    expect(body.error.data['stack']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('/apps/api/src');
  });
});

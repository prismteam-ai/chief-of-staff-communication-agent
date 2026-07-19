import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  productHealthResponseSchema,
  listCommunicationsResultSchema,
} from '@chief/contracts';

import { RequestAuthorityError } from './auth/index.js';
import { createContext } from './context.js';
import { createApiHandler } from './handler.js';
import {
  createFixtureProductService,
  createFixtureRequestContext,
} from './fixture-product-service.js';

const lambdaContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'chief-api-test',
  functionVersion: '$LATEST',
  invokedFunctionArn:
    'arn:aws:lambda:us-east-2:417242953053:function:chief-api-test',
  memoryLimitInMB: '512',
  awsRequestId: 'fixture-lambda-request',
  logGroupName: '/aws/lambda/chief-api-test',
  logStreamName: 'fixture-stream',
  getRemainingTimeInMillis: () => 30_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

function eventFor(
  procedure: string,
  options: {
    readonly input?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 {
  const rawQueryString =
    options.input === undefined
      ? ''
      : `input=${encodeURIComponent(JSON.stringify(options.input))}`;
  return {
    version: '2.0',
    routeKey: 'ANY /trpc/{proxy+}',
    rawPath: `/trpc/${procedure}`,
    rawQueryString,
    headers: { accept: 'application/json', ...options.headers },
    requestContext: {
      accountId: '417242953053',
      apiId: 'fixture-api',
      domainName: 'fixture.execute-api.us-east-2.amazonaws.com',
      domainPrefix: 'fixture',
      http: {
        method: 'GET',
        path: `/trpc/${procedure}`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'fixture-request',
      routeKey: 'ANY /trpc/{proxy+}',
      stage: '$default',
      time: '17/Jul/2026:12:00:00 +0000',
      timeEpoch: 1_768_558_400_000,
    },
    pathParameters: { proxy: procedure },
    isBase64Encoded: false,
  };
}

function resultData(responseBody: string | undefined): unknown {
  const envelope = JSON.parse(responseBody ?? '{}') as {
    result?: { data?: unknown };
  };
  return envelope.result?.data;
}

const handler = createApiHandler({
  productService: createFixtureProductService(),
  requestContext: createFixtureRequestContext(),
  authMode: 'local-test',
});

const enforcedHandler = createApiHandler({
  productService: createFixtureProductService(),
  requestContext: createFixtureRequestContext(),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API Gateway tRPC Lambda integration', () => {
  it('routes health and typed product queries through the official adapter', async () => {
    const healthResponse = await enforcedHandler(
      eventFor('system.health'),
      lambdaContext,
    );
    expect(healthResponse.statusCode).toBe(200);
    expect(
      productHealthResponseSchema.parse(resultData(healthResponse.body)),
    ).toMatchObject({
      service: 'chief-api',
      status: 'ok',
      foundationOnly: false,
    });

    const listResponse = await handler(
      eventFor('communications.list', { input: { limit: 2 } }),
      lambdaContext,
    );
    expect(listResponse.statusCode).toBe(200);
    expect(
      listCommunicationsResultSchema.parse(resultData(listResponse.body)).items,
    ).toHaveLength(2);
  });

  it('protects product procedures in enforced mode', async () => {
    for (const headers of [
      undefined,
      { authorization: 'Basic not-a-session' },
      { authorization: 'Bearer malformed' },
    ]) {
      const response = await enforcedHandler(
        eventFor('communications.list', {
          input: { limit: 2 },
          ...(headers === undefined ? {} : { headers }),
        }),
        lambdaContext,
      );

      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('tenant_public_assessment');
      expect(response.body).not.toContain('not-a-session');
    }
  });

  it('returns forbidden for inactive server membership or grants', async () => {
    const inactiveAuthorityHandler = createApiHandler({
      productService: createFixtureProductService(),
      requestContext: createFixtureRequestContext(),
      requestAuthorityResolver: {
        resolve: () =>
          Promise.reject(
            new RequestAuthorityError('forbidden', 'inactive_membership'),
          ),
      },
    });

    const response = await inactiveAuthorityHandler(
      eventFor('communications.list', {
        input: { limit: 2 },
        headers: { authorization: 'Bearer a.b.c' },
      }),
      lambdaContext,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('inactive_membership');
  });

  it('refuses the local-test authority lane in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() =>
      createContext(
        {
          event: eventFor('communications.list'),
          context: lambdaContext,
          info: {} as never,
        },
        {
          productService: createFixtureProductService(),
          requestContext: createFixtureRequestContext(),
          authMode: 'local-test',
        },
      ),
    ).toThrow('LOCAL_TEST_AUTH_FORBIDDEN_IN_PRODUCTION');
  });

  it('returns bounded protocol errors for malformed input', async () => {
    const response = await handler(
      eventFor('communications.list', { input: { limit: 101 } }),
      lambdaContext,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('tenant_public_assessment');
  });

  it('denies caller-selected tenant/account authority at the Lambda boundary', async () => {
    const response = await handler(
      eventFor('communications.list', {
        input: { limit: 2 },
        headers: {
          'x-tenant-id': 'tenant-attacker',
          'x-account-id': 'account-attacker',
        },
      }),
      lambdaContext,
    );

    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('tenant_public_assessment');
    expect(response.body).not.toContain('account-gmail-fixture');
  });

  it('rejects unknown direct-effect procedures', async () => {
    const response = await handler(
      eventFor('effects.send', { input: { provider: 'gmail' } }),
      lambdaContext,
    );

    expect(response.statusCode).toBe(404);
  });

  it('never includes an unknown caller-controlled procedure path in server diagnostics', async () => {
    const attackerPath = `secret-token-${'a'.repeat(80)}`;
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      const response = await handler(eventFor(attackerPath), lambdaContext);
      expect(response.statusCode).toBe(404);

      const diagnostics = JSON.stringify([
        ...stdout.mock.calls,
        ...stderr.mock.calls,
      ]);
      expect(diagnostics).not.toContain(attackerPath);
      expect(diagnostics).toContain('unknown_procedure');
      expect(diagnostics).toMatch(/[a-f0-9]{64}/u);
      expect(diagnostics.length).toBeLessThan(8_192);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

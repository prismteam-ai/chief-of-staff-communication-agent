import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from '@chief/contracts';

import { handler } from './handler.js';

const event: APIGatewayProxyEventV2 = {
  version: '2.0',
  routeKey: 'ANY /trpc/{proxy+}',
  rawPath: '/trpc/system.health',
  rawQueryString: '',
  headers: { accept: 'application/json' },
  requestContext: {
    accountId: '417242953053',
    apiId: 'fixture-api',
    domainName: 'fixture.execute-api.us-east-2.amazonaws.com',
    domainPrefix: 'fixture',
    http: {
      method: 'GET',
      path: '/trpc/system.health',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'vitest',
    },
    requestId: 'fixture-request',
    routeKey: 'ANY /trpc/{proxy+}',
    stage: '$default',
    time: '17/Jul/2026:11:00:00 +0000',
    timeEpoch: 1_768_558_400_000,
  },
  pathParameters: { proxy: 'system.health' },
  isBase64Encoded: false,
};

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

describe('API Gateway tRPC Lambda integration', () => {
  it('routes the CDK proxy shape through the official adapter', async () => {
    const response = await handler(event, lambdaContext);

    expect(response.statusCode).toBe(200);
    const envelope = JSON.parse(response.body ?? '{}') as {
      result?: { data?: unknown };
    };
    const health = healthResponseSchema.parse(envelope.result?.data);
    expect(health).toMatchObject({
      service: 'chief-api',
      status: 'ok',
      foundationOnly: true,
    });
  });
});

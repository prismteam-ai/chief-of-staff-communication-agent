import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ChiefFoundationStack } from '../lib/chief-foundation-stack.js';

function createTemplate(): Template {
  const app = new cdk.App();
  const stack = new ChiefFoundationStack(app, 'TestChiefFoundation', {
    env: { account: '417242953053', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

const template = createTemplate();

interface LambdaResponse {
  body?: string;
  statusCode: number;
}

interface SynthesizedLambdaResource {
  Type: string;
  Properties?: {
    Code?: { S3Key?: unknown };
    Environment?: {
      Variables?: { POWERTOOLS_SERVICE_NAME?: unknown };
    };
    Runtime?: unknown;
  };
}

interface SynthesizedTemplate {
  Resources: Record<string, SynthesizedLambdaResource>;
}

type SynthesizedHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => LambdaResponse | Promise<LambdaResponse>;

const require = createRequire(import.meta.url);

function apiGatewayEvent(rawPath: string): Record<string, unknown> {
  const routePrefix = rawPath.startsWith('/trpc/') ? '/trpc/' : '/mcp/';
  const routeKey =
    routePrefix === '/trpc/' ? 'ANY /trpc/{proxy+}' : 'ANY /mcp/{proxy+}';

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { accept: 'application/json' },
    requestContext: {
      accountId: '417242953053',
      apiId: 'fixture-api',
      domainName: 'fixture.execute-api.us-east-2.amazonaws.com',
      domainPrefix: 'fixture',
      http: {
        method: 'GET',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'fixture-request',
      routeKey,
      stage: '$default',
      time: '17/Jul/2026:11:00:00 +0000',
      timeEpoch: 1_768_558_400_000,
    },
    pathParameters: { proxy: rawPath.replace(routePrefix, '') },
    isBase64Encoded: false,
  };
}

function lambdaContext(functionName: string): Record<string, unknown> {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:us-east-2:417242953053:function:${functionName}`,
    memoryLimitInMB: '512',
    awsRequestId: 'fixture-lambda-request',
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: 'fixture-stream',
    getRemainingTimeInMillis: () => 30_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

function productLambdaBundles(
  synthesizedTemplate: SynthesizedTemplate,
  outputDirectory: string,
): Map<string, string> {
  const bundles = new Map<string, string>();

  for (const resource of Object.values(synthesizedTemplate.Resources)) {
    if (
      resource.Type !== 'AWS::Lambda::Function' ||
      resource.Properties?.Runtime !== 'nodejs22.x'
    ) {
      continue;
    }

    const serviceName =
      resource.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME;
    if (serviceName !== 'chief-api' && serviceName !== 'chief-mcp') {
      continue;
    }

    const assetKey = resource.Properties.Code?.S3Key;
    expect(typeof assetKey).toBe('string');

    const assetMatch = /^([a-f0-9]{64})\.zip$/.exec(String(assetKey));
    expect(assetMatch).not.toBeNull();
    const assetDirectory = path.join(
      outputDirectory,
      `asset.${assetMatch?.[1]}`,
    );
    const javaScriptFiles = readdirSync(assetDirectory).filter((file) =>
      file.endsWith('.js'),
    );
    expect(javaScriptFiles).toEqual(['index.js']);
    bundles.set(String(serviceName), path.join(assetDirectory, 'index.js'));
  }

  expect([...bundles.keys()].sort()).toEqual(['chief-api', 'chief-mcp']);
  return bundles;
}

describe('Chief foundation stack', () => {
  it('creates the required private web, API, and observable Lambda resources', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200 }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200 }),
        ]),
      }),
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Runtime: 'nodejs22.x',
        TracingConfig: { Mode: 'Active' },
        Environment: {
          Variables: Match.objectLike({
            POWERTOOLS_METRICS_NAMESPACE: 'ChiefFoundation',
          }),
        },
      },
      2,
    );
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
    });
  });

  it('deploys the built web app and invalidates changed CloudFront assets', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketName: {
        Ref: Match.stringLikeRegexp('WebBucket'),
      },
      Prune: true,
      WaitForDistributionInvalidation: true,
      DistributionId: {
        Ref: Match.stringLikeRegexp('WebDistribution'),
      },
      DistributionPaths: ['/*'],
    });
  });

  it('does not provision future business or provider infrastructure', () => {
    const prohibited = [
      'AWS::Amplify::App',
      'AWS::SQS::Queue',
      'AWS::DynamoDB::Table',
      'AWS::RDS::DBInstance',
      'AWS::OpenSearchService::Domain',
      'AWS::OpenSearchServerless::Collection',
      'AWS::Bedrock::KnowledgeBase',
      'AWS::Cognito::UserPool',
      'AWS::SecretsManager::Secret',
      'AWS::Events::Rule',
      'AWS::StepFunctions::StateMachine',
      'AWS::SNS::Topic',
    ];

    for (const resourceType of prohibited) {
      expect(template.findResources(resourceType)).toEqual({});
    }
  });

  it('synthesizes executable product Lambda assets for the API and MCP routes', async () => {
    const outputDirectory = mkdtempSync(
      path.join(tmpdir(), 'chief-cdk-assets-'),
    );

    try {
      const app = new cdk.App({ outdir: outputDirectory });
      const stack = new ChiefFoundationStack(app, 'AssetChiefFoundation', {
        env: { account: '417242953053', region: 'us-east-2' },
      });
      const assembly = app.synth();
      const synthesizedTemplate = assembly.getStackArtifact(stack.artifactId)
        .template as SynthesizedTemplate;
      const bundles = productLambdaBundles(
        synthesizedTemplate,
        outputDirectory,
      );

      for (const bundlePath of bundles.values()) {
        const bundleSource = readFileSync(bundlePath, 'utf8');
        expect(bundleSource).not.toContain(
          'import { createRequire } from module;',
        );
        const loadedBundle = require(bundlePath) as { handler?: unknown };
        expect(typeof loadedBundle.handler).toBe('function');
      }

      const apiHandler = require(bundles.get('chief-api') as string) as {
        handler: SynthesizedHandler;
      };
      const apiResponse = await apiHandler.handler(
        apiGatewayEvent('/trpc/system.health'),
        lambdaContext('chief-api-test'),
      );
      expect(apiResponse.statusCode).toBe(200);
      expect(JSON.parse(apiResponse.body ?? '{}')).toMatchObject({
        result: {
          data: {
            service: 'chief-api',
            status: 'ok',
          },
        },
      });

      const mcpHandler = require(bundles.get('chief-mcp') as string) as {
        handler: SynthesizedHandler;
      };
      const mcpResponse = await mcpHandler.handler(
        apiGatewayEvent('/mcp/health'),
        lambdaContext('chief-mcp-test'),
      );
      expect(mcpResponse.statusCode).toBe(200);
      expect(JSON.parse(mcpResponse.body ?? '{}')).toMatchObject({
        service: 'chief-mcp',
        status: 'ok',
      });
    } finally {
      rmSync(outputDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});

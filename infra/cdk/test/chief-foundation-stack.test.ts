import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

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

interface LambdaTemplateResource {
  readonly Properties?: {
    readonly Environment?: {
      readonly Variables?: Record<string, unknown>;
    };
    readonly ReservedConcurrentExecutions?: number;
  };
}

interface PolicyStatement {
  readonly Action?: string | readonly string[];
  readonly Condition?: unknown;
  readonly Resource?: unknown;
}

function actionValues(action: PolicyStatement['Action']): readonly string[] {
  if (action === undefined) return [];
  return typeof action === 'string' ? [action] : action;
}

function applicationPolicyStatements(
  functionId: 'ApiFunction' | 'McpFunction',
): PolicyStatement[] {
  const matches = Object.entries(
    template.findResources('AWS::IAM::Policy'),
  ).filter(([logicalId]) =>
    logicalId.includes(`${functionId}ServiceRoleDefaultPolicy`),
  ) as Array<
    [
      string,
      {
        readonly Properties?: {
          readonly PolicyDocument?: { readonly Statement?: PolicyStatement[] };
        };
      },
    ]
  >;
  expect(matches).toHaveLength(1);
  return matches[0]?.[1].Properties?.PolicyDocument?.Statement ?? [];
}

interface CloudFrontRequest {
  method: string;
  uri: string;
}

type SpaRewriteHandler = (event: {
  request: CloudFrontRequest;
}) => CloudFrontRequest;

function synthesizedSpaRewriteHandler(): SpaRewriteHandler {
  const functions = Object.values(
    template.findResources('AWS::CloudFront::Function'),
  ) as Array<{ Properties: { FunctionCode: string } }>;
  expect(functions).toHaveLength(1);
  const source = functions[0]?.Properties.FunctionCode;
  expect(source).toBeTypeOf('string');
  return runInNewContext(`${source}\nhandler;`, {}) as SpaRewriteHandler;
}

type SynthesizedHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => LambdaResponse | Promise<LambdaResponse>;

const require = createRequire(import.meta.url);

function apiGatewayEvent(
  rawPath: string,
  headers: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const routePrefix = rawPath.startsWith('/trpc/') ? '/trpc/' : '/mcp/';
  const routeKey =
    routePrefix === '/trpc/' ? 'ANY /trpc/{proxy+}' : 'ANY /mcp/{proxy+}';

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { accept: 'application/json', ...headers },
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
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/trpc/*' }),
          Match.objectLike({ PathPattern: '/auth/*' }),
          Match.objectLike({ PathPattern: '/mcp' }),
          Match.objectLike({ PathPattern: '/mcp/*' }),
        ]),
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request' }),
          ],
        }),
      }),
    });
    template.resourceCountIs('AWS::CloudFront::Function', 1);
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      FunctionCode: Match.stringLikeRegexp("request.uri = '/index.html'"),
    });
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({ Override: true }),
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ReferrerPolicy: {
            Override: true,
            ReferrerPolicy: 'same-origin',
          },
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 63_072_000,
            IncludeSubdomains: true,
            Override: true,
            Preload: true,
          }),
        }),
      }),
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      DeletionProtection: 'ACTIVE',
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 14,
          TemporaryPasswordValidityDays: 3,
        }),
      },
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AccessTokenValidity: 15,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: [Match.anyValue()],
      EnableTokenRevocation: true,
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
      IdTokenValidity: 15,
      PreventUserExistenceErrors: 'ENABLED',
      LogoutURLs: [Match.anyValue()],
      RefreshTokenValidity: 10_080,
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      },
    });
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'chief-communications-417242953053-us-east-2',
      ManagedLoginVersion: 1,
    });
    const userPoolClients = Object.values(
      template.findResources('AWS::Cognito::UserPoolClient'),
    );
    expect(JSON.stringify(userPoolClients)).toContain('/auth/callback');
    expect(JSON.stringify(userPoolClients)).not.toContain('example.com');
    expect(JSON.stringify(userPoolClients)).not.toContain('implicit');
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Runtime: 'nodejs22.x',
        TracingConfig: { Mode: 'Active' },
        Environment: {
          Variables: Match.objectLike({
            EXTERNAL_EFFECTS: 'disabled',
            MODEL_EFFECTS: 'disabled',
            NODE_ENV: 'production',
            POWERTOOLS_METRICS_NAMESPACE: 'ChiefFoundation',
            PROVIDER_EFFECTS: 'disabled',
            PUBLIC_FIXTURE_MODE: 'enabled',
            WORK_MANAGEMENT_EFFECTS: 'disabled',
          }),
        },
      },
      1,
    );
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      { Timeout: 25 },
      2,
    );
    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as LambdaTemplateResource[];
    expect(
      functions.every(
        ({ Properties }) =>
          Properties?.ReservedConcurrentExecutions === undefined,
      ),
    ).toBe(true);
    template.resourceCountIs('AWS::Logs::LogGroup', 4);
    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 90 },
      4,
    );
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({
        DestinationArn: Match.anyValue(),
        Format: Match.stringLikeRegexp('\\$context\\.requestId'),
      }),
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 40,
        ThrottlingRateLimit: 20,
      },
    });
  });

  it('rewrites direct UI navigation without masking API, MCP, or asset errors', () => {
    const handler = synthesizedSpaRewriteHandler();
    expect(
      handler({
        request: { method: 'GET', uri: '/communications/thread-001' },
      }).uri,
    ).toBe('/index.html');
    expect(
      handler({ request: { method: 'HEAD', uri: '/approvals/' } }).uri,
    ).toBe('/index.html');
    expect(
      handler({ request: { method: 'GET', uri: '/trpc/not-found' } }).uri,
    ).toBe('/trpc/not-found');
    expect(handler({ request: { method: 'GET', uri: '/trpc' } }).uri).toBe(
      '/trpc',
    );
    expect(
      handler({ request: { method: 'GET', uri: '/mcp/not-found' } }).uri,
    ).toBe('/mcp/not-found');
    expect(
      handler({ request: { method: 'GET', uri: '/auth/login' } }).uri,
    ).toBe('/auth/login');
    expect(
      handler({ request: { method: 'GET', uri: '/assets/missing.js' } }).uri,
    ).toBe('/assets/missing.js');
    expect(
      handler({ request: { method: 'POST', uri: '/communications' } }).uri,
    ).toBe('/communications');

    const distributions = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    ) as Array<{
      Properties: {
        DistributionConfig: {
          CacheBehaviors?: Array<{ FunctionAssociations?: unknown }>;
          CustomErrorResponses?: unknown;
        };
      };
    }>;
    const configuration = distributions[0]?.Properties.DistributionConfig;
    expect(configuration).not.toHaveProperty('CustomErrorResponses');
    expect(
      configuration?.CacheBehaviors?.every(
        (behavior) => behavior.FunctionAssociations === undefined,
      ),
    ).toBe(true);
  });

  it('exposes only the stable API and MCP route families', () => {
    const routes = Object.values(
      template.findResources('AWS::ApiGatewayV2::Route'),
    ).map(
      (resource) =>
        (resource as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routes.sort()).toEqual(
      [
        'ANY /auth/{proxy+}',
        'ANY /mcp',
        'ANY /mcp/{proxy+}',
        'ANY /trpc/{proxy+}',
      ].sort(),
    );

    const outputs = template.toJSON().Outputs as Record<
      string,
      { Value: unknown }
    >;
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining([
        'ApiHealthUrl',
        'ApiUrl',
        'BrowserLoginUrl',
        'CloudFrontApiUrl',
        'CloudFrontMcpUrl',
        'CognitoDomain',
        'CognitoIssuer',
        'CognitoUserPoolClientId',
        'CognitoUserPoolId',
        'McpHealthUrl',
        'McpUrl',
        'WebUrl',
      ]),
    );
  });

  it('imports exact product resources with scoped permissions and no credential values', () => {
    const lambdaResources = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as LambdaTemplateResource[];
    const productFunctions = lambdaResources.filter((resource) => {
      const service =
        resource.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME;
      return service === 'chief-api' || service === 'chief-mcp';
    });
    expect(productFunctions).toHaveLength(2);

    const apiFunction = productFunctions.find(
      (resource) =>
        resource.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME ===
        'chief-api',
    );
    const mcpFunction = productFunctions.find(
      (resource) =>
        resource.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME ===
        'chief-mcp',
    );
    expect(apiFunction?.Properties?.Environment?.Variables).not.toHaveProperty(
      'OUTBOX_QUEUE_URL',
    );

    for (const function_ of productFunctions) {
      const environment = function_.Properties?.Environment?.Variables ?? {};
      expect(environment).toMatchObject({ NODE_ENV: 'production' });
      for (const forbiddenKey of [
        'API_KEY',
        'CLIENT_SECRET',
        'PASSWORD',
        'REFRESH_TOKEN',
      ]) {
        expect(environment).not.toHaveProperty(forbiddenKey);
      }
      expect(JSON.stringify(environment)).not.toMatch(
        /(?:bearer\s|sk-[a-z0-9]|gh[pousr]_|-----BEGIN)/iu,
      );
    }

    const apiEnvironment = apiFunction?.Properties?.Environment?.Variables;
    expect(apiEnvironment).toMatchObject({
      FIXTURE_TENANT_ID: 'chief-evaluator-fixture',
      PUBLIC_FIXTURE_MODE: 'enabled',
    });
    expect(apiEnvironment?.AUTH_SESSION_TTL_SECONDS).toBe('900');
    expect(apiEnvironment?.AUTH_STATE_TTL_SECONDS).toBe('600');
    expect(apiEnvironment?.COGNITO_DOMAIN).toBeDefined();
    expect(apiEnvironment?.COGNITO_ISSUER).toBeDefined();
    expect(apiEnvironment?.COGNITO_USER_POOL_CLIENT_ID).toBeDefined();
    expect(apiEnvironment?.COGNITO_USER_POOL_ID).toBeDefined();
    expect(apiEnvironment?.REQUEST_AUTH_MODE).toBe('enforced');
    expect(JSON.stringify(apiEnvironment?.COGNITO_ISSUER)).toContain(
      'https://cognito-idp.us-east-2.',
    );
    const mcpEnvironment = mcpFunction?.Properties?.Environment?.Variables;
    expect(mcpEnvironment?.COGNITO_ISSUER).toBeDefined();
    expect(mcpEnvironment?.COGNITO_USER_POOL_CLIENT_ID).toBeDefined();
    expect(mcpEnvironment?.COGNITO_USER_POOL_ID).toBeDefined();
    expect(mcpEnvironment?.REQUEST_AUTH_MODE).toBe('enforced');
    expect(mcpEnvironment).not.toHaveProperty('AUTH_SESSION_TTL_SECONDS');
    expect(mcpEnvironment).not.toHaveProperty('AUTH_STATE_TTL_SECONDS');
    expect(mcpEnvironment).not.toHaveProperty('COGNITO_DOMAIN');
    for (const unusedEnvironmentKey of [
      'CONNECTOR_RUNTIME_TABLE_NAME',
      'EXTERNAL_EFFECTS',
      'FIXTURE_TENANT_ID',
      'MODEL_EFFECTS',
      'PROVIDER_EFFECTS',
      'PUBLIC_FIXTURE_MODE',
      'PUBLIC_ROUTE_SCOPE',
      'WORK_MANAGEMENT_EFFECTS',
    ]) {
      expect(mcpEnvironment).not.toHaveProperty(unusedEnvironmentKey);
    }

    const apiStatements = applicationPolicyStatements('ApiFunction');
    const mcpStatements = applicationPolicyStatements('McpFunction');
    const apiActions = apiStatements.flatMap(({ Action }) =>
      actionValues(Action),
    );
    const mcpActions = mcpStatements.flatMap(({ Action }) =>
      actionValues(Action),
    );
    expect(apiActions).toEqual(
      expect.arrayContaining([
        // ConditionCheckItem and UpdateItem are required by the transactional
        // revise and approve paths. Their absence denied every TransactWriteItems
        // containing an Update, so drafts could be created but never revised.
        'dynamodb:ConditionCheckItem',
        'dynamodb:DeleteItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:TransactWriteItems',
        'dynamodb:UpdateItem',
        'kms:Decrypt',
        'kms:GenerateDataKey',
        's3:GetObject',
      ]),
    );
    expect(mcpActions).toEqual(
      expect.arrayContaining([
        'dynamodb:Query',
        'dynamodb:TransactWriteItems',
        'kms:Decrypt',
        's3:GetObject',
      ]),
    );
    for (const actions of [apiActions, mcpActions]) {
      expect(actions).not.toContain('dynamodb:Scan');
      expect(actions).not.toContain('events:PutEvents');
      expect(actions).not.toContain('secretsmanager:GetSecretValue');
      expect(actions).not.toContain('s3:DeleteObject');
    }
    expect(apiActions).not.toContain('sqs:SendMessage');
    expect(mcpActions).not.toContain('dynamodb:DeleteItem');
    expect(mcpActions).not.toContain('kms:GenerateDataKey');
    expect(mcpActions).not.toContain('sqs:SendMessage');
    // The MCP function shares only the read-only core-table grant. The widened
    // transactional verbs must stay on the API function alone.
    expect(mcpActions).not.toContain('dynamodb:UpdateItem');
    expect(mcpActions).not.toContain('dynamodb:ConditionCheckItem');

    const apiPolicy = JSON.stringify(apiStatements);
    const mcpPolicy = JSON.stringify(mcpStatements);
    expect(apiPolicy).not.toContain(
      'chief-communications:runtime:outbox-queue-arn',
    );
    expect(apiPolicy).not.toContain(
      'chief-communications:runtime:ingestion-queue-arn',
    );
    expect(mcpPolicy).not.toContain(
      'chief-communications:runtime:outbox-queue-arn',
    );
    expect(mcpPolicy).not.toContain(
      'chief-communications:runtime:connector-runtime-table-arn',
    );
    expect(`${apiPolicy}${mcpPolicy}`).not.toMatch(
      /(?:digest-key-secret|event-bus|ingestion-queue)/u,
    );
    const browserSessionStatements = apiStatements.filter(({ Action }) => {
      const actions = actionValues(Action);
      return (
        actions.includes('dynamodb:PutItem') &&
        actions.includes('dynamodb:DeleteItem')
      );
    });
    expect(browserSessionStatements).toHaveLength(1);
    expect(JSON.stringify(browserSessionStatements[0]?.Resource)).toContain(
      'chief-communications:runtime:core-table-arn',
    );
    expect(browserSessionStatements[0]?.Condition).toEqual({
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    });

    const apiWritePolicy = JSON.stringify(
      apiStatements.filter(({ Action }) =>
        actionValues(Action).includes('dynamodb:PutItem'),
      ),
    );
    const mcpWritePolicy = JSON.stringify(
      mcpStatements.filter(({ Action }) =>
        actionValues(Action).includes('dynamodb:PutItem'),
      ),
    );
    expect(apiWritePolicy).toContain(
      'chief-communications:runtime:connector-runtime-table-arn',
    );
    expect(mcpWritePolicy).not.toContain(
      'chief-communications:runtime:connector-runtime-table-arn',
    );

    const dataStatements = [...apiStatements, ...mcpStatements].filter(
      ({ Action }) =>
        actionValues(Action).some((action) =>
          /^(?:dynamodb|kms|s3|sqs):/u.test(action),
        ),
    );
    expect(dataStatements.every(({ Resource }) => Resource !== '*')).toBe(true);
  });

  it('enables the core-table TTL attribute for bounded auth records', () => {
    template.resourceCountIs('Custom::AWS', 1);
    const ttlResources = template.findResources('Custom::AWS');
    expect(JSON.stringify(ttlResources)).toContain('UpdateTimeToLive');
    expect(JSON.stringify(ttlResources)).toContain(
      String.raw`\"AttributeName\":\"ttl\"`,
    );
    expect(JSON.stringify(ttlResources)).toContain(
      String.raw`\"Enabled\":true`,
    );
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as Array<{
      Properties?: {
        PolicyDocument?: { Statement?: PolicyStatement[] };
      };
    }>;
    const ttlPolicy = policies.find(({ Properties }) =>
      (Properties?.PolicyDocument?.Statement ?? []).some(({ Action }) =>
        actionValues(Action).includes('dynamodb:UpdateTimeToLive'),
      ),
    );
    const ttlStatements =
      ttlPolicy?.Properties?.PolicyDocument?.Statement ?? [];
    const updateStatement = ttlStatements.filter(({ Action }) =>
      actionValues(Action).includes('dynamodb:UpdateTimeToLive'),
    );
    const decryptStatement = ttlStatements.filter(({ Action }) =>
      actionValues(Action).includes('kms:Decrypt'),
    );
    expect(updateStatement).toHaveLength(1);
    expect(JSON.stringify(updateStatement[0]?.Resource)).toContain(
      'chief-communications:runtime:core-table-arn',
    );
    expect(decryptStatement).toHaveLength(1);
    expect(JSON.stringify(decryptStatement[0]?.Resource)).toContain(
      'chief-communications:runtime:data-key-arn',
    );
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

      const smugglingResponse = await apiHandler.handler(
        apiGatewayEvent('/trpc/system.health', {
          'x-tenant-id': 'tenant-attacker-secret',
        }),
        lambdaContext('chief-api-test'),
      );
      expect(smugglingResponse.statusCode).toBeGreaterThanOrEqual(400);
      expect(smugglingResponse.statusCode).toBeLessThan(500);
      const publicError = smugglingResponse.body ?? '';
      expect(publicError).toContain('The request is not permitted.');
      expect(publicError).not.toMatch(
        /(?:"path"|"stack"|TRPCError|node_modules|apps[\\/]api[\\/]src|tenant-attacker-secret|[A-Z]:\\)/u,
      );

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

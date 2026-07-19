import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import { runtimeExportNames } from './runtime-exports.js';

const REPOSITORY_ROOT = path.resolve(process.cwd(), '../..');
const PROJECT_NAME = 'chief-communications';
const REPOSITORY_NAME = 'chief-of-staff-communication-agent';
const FIXTURE_TENANT_ID = 'chief-evaluator-fixture';
const SPA_REWRITE_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var isApiPath = uri === '/trpc' || uri.indexOf('/trpc/') === 0 ||
    uri === '/mcp' || uri.indexOf('/mcp/') === 0 ||
    uri === '/auth' || uri.indexOf('/auth/') === 0;
  if (isApiPath || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return request;
  }
  var finalSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (uri.charAt(uri.length - 1) === '/' || finalSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

interface RuntimeBindings {
  readonly connectorRuntimeTableArn: string;
  readonly connectorRuntimeTableName: string;
  readonly coreTableArn: string;
  readonly coreTableName: string;
  readonly dataKeyArn: string;
  readonly retrievalTableArn: string;
  readonly retrievalTableName: string;
  readonly snapshotBucketArn: string;
  readonly snapshotBucketName: string;
}

export class ChiefFoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('project_name', PROJECT_NAME);
    cdk.Tags.of(this).add('repository', REPOSITORY_NAME);

    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    });

    const apiLogGroup = this.createLogGroup('ApiLogGroup');
    const mcpLogGroup = this.createLogGroup('McpLogGroup');
    const apiAccessLogGroup = this.createLogGroup('ApiAccessLogGroup');
    const authTtlLogGroup = this.createLogGroup('AuthTtlLogGroup');
    const runtime = this.importRuntimeBindings();
    new customResources.AwsCustomResource(this, 'EnableCoreTableAuthTtl', {
      onCreate: {
        service: 'DynamoDB',
        action: 'UpdateTimeToLive',
        parameters: {
          TableName: runtime.coreTableName,
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
        physicalResourceId: customResources.PhysicalResourceId.of(
          `${PROJECT_NAME}-core-auth-ttl-v1`,
        ),
      },
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:UpdateTimeToLive'],
          resources: [runtime.coreTableArn],
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: [runtime.dataKeyArn],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: authTtlLogGroup,
    });
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PROJECT_NAME}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const cognitoIssuer = `https://cognito-idp.${this.region}.${this.urlSuffix}/${userPool.userPoolId}`;
    const userPoolDomain = userPool.addDomain('HostedUiDomain', {
      cognitoDomain: {
        domainPrefix: `${PROJECT_NAME}-${this.account}-${this.region}`,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });
    const fixtureEnvironment = {
      EXTERNAL_EFFECTS: 'disabled',
      FIXTURE_TENANT_ID,
      MODEL_EFFECTS: 'disabled',
      PROVIDER_EFFECTS: 'disabled',
      PUBLIC_FIXTURE_MODE: 'enabled',
      WORK_MANAGEMENT_EFFECTS: 'disabled',
    };

    const apiFunction = this.createFunction(
      'ApiFunction',
      path.join(REPOSITORY_ROOT, 'apps/api/src/handler.ts'),
      'chief-api',
      apiLogGroup,
      {
        ...fixtureEnvironment,
        AUTH_SESSION_TTL_SECONDS: '900',
        AUTH_STATE_TTL_SECONDS: '300',
        COGNITO_DOMAIN: userPoolDomain.baseUrl(),
        COGNITO_ISSUER: cognitoIssuer,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        CONNECTOR_RUNTIME_TABLE_NAME: runtime.connectorRuntimeTableName,
        CORE_TABLE_NAME: runtime.coreTableName,
        PUBLIC_ROUTE_SCOPE: 'fixture-read-propose-approve-effect-disabled',
        REQUEST_AUTH_MODE: 'enforced',
        RETRIEVAL_TABLE_NAME: runtime.retrievalTableName,
        SNAPSHOT_BUCKET_NAME: runtime.snapshotBucketName,
      },
    );
    const mcpFunction = this.createFunction(
      'McpFunction',
      path.join(REPOSITORY_ROOT, 'apps/mcp/src/handler.ts'),
      'chief-mcp',
      mcpLogGroup,
      {
        COGNITO_ISSUER: cognitoIssuer,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        CORE_TABLE_NAME: runtime.coreTableName,
        REQUEST_AUTH_MODE: 'enforced',
        RETRIEVAL_TABLE_NAME: runtime.retrievalTableName,
        SNAPSHOT_BUCKET_NAME: runtime.snapshotBucketName,
      },
    );
    this.grantApiRuntimeAccess(apiFunction, runtime);
    this.grantMcpRuntimeAccess(mcpFunction, runtime);

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT_NAME}-api`,
      corsPreflight: {
        allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'],
        allowMethods: [
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.OPTIONS,
          apigwv2.CorsHttpMethod.POST,
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    httpApi.addRoutes({
      path: '/trpc/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration(
        'ApiIntegration',
        apiFunction,
      ),
    });
    httpApi.addRoutes({
      path: '/auth/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration(
        'BrowserAuthIntegration',
        apiFunction,
      ),
    });

    const mcpIntegration = new integrations.HttpLambdaIntegration(
      'McpIntegration',
      mcpFunction,
    );
    httpApi.addRoutes({
      path: '/mcp',
      methods: [apigwv2.HttpMethod.ANY],
      integration: mcpIntegration,
    });
    httpApi.addRoutes({
      path: '/mcp/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: mcpIntegration,
    });

    const defaultStage = httpApi.defaultStage?.node
      .defaultChild as apigwv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: apiAccessLogGroup.logGroupArn,
      format: JSON.stringify({
        apiId: '$context.apiId',
        error: '$context.error.message',
        httpMethod: '$context.httpMethod',
        integrationError: '$context.integrationErrorMessage',
        integrationLatency: '$context.integrationLatency',
        requestId: '$context.requestId',
        responseLatency: '$context.responseLatency',
        routeKey: '$context.routeKey',
        status: '$context.status',
      }),
    };
    defaultStage.defaultRouteSettings = {
      throttlingBurstLimit: 40,
      throttlingRateLimit: 20,
    };

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'SecurityHeadersPolicy',
      {
        responseHeadersPolicyName: `${PROJECT_NAME}-security-headers`,
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: [
              "default-src 'self'",
              "base-uri 'self'",
              `connect-src 'self' https://*.execute-api.${this.region}.${this.urlSuffix}`,
              "font-src 'self' data:",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "img-src 'self' data: blob:",
              "object-src 'none'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
            ].join('; '),
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(730),
            includeSubdomains: true,
            override: true,
            preload: true,
          },
          xssProtection: {
            modeBlock: true,
            override: true,
            protection: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: 'Permissions-Policy',
              override: true,
              value:
                'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
            },
          ],
        },
      },
    );
    const spaRewriteFunction = new cloudfront.Function(
      this,
      'SpaNavigationRewrite',
      {
        code: cloudfront.FunctionCode.fromInline(SPA_REWRITE_FUNCTION_CODE),
        comment:
          'Rewrites extensionless browser navigation only; API and asset errors remain truthful.',
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      },
    );
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewriteFunction,
          },
        ],
        responseHeadersPolicy,
      },
    });
    const apiOrigin = new origins.HttpOrigin(
      `${httpApi.httpApiId}.execute-api.${this.region}.${this.urlSuffix}`,
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
    );
    const apiBehavior: cloudfront.AddBehaviorOptions = {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };
    distribution.addBehavior('/trpc/*', apiOrigin, apiBehavior);
    distribution.addBehavior('/auth/*', apiOrigin, apiBehavior);
    distribution.addBehavior('/mcp', apiOrigin, apiBehavior);
    distribution.addBehavior('/mcp/*', apiOrigin, apiBehavior);
    const webUrl = `https://${distribution.distributionDomainName}`;
    const userPoolClient = userPool.addClient('BrowserClient', {
      userPoolClientName: `${PROJECT_NAME}-browser`,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${webUrl}/auth/callback`],
        logoutUrls: [`${webUrl}/`],
      },
      authSessionValidity: cdk.Duration.minutes(5),
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.days(7),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    apiFunction.addEnvironment(
      'COGNITO_USER_POOL_CLIENT_ID',
      userPoolClient.userPoolClientId,
    );
    mcpFunction.addEnvironment(
      'COGNITO_USER_POOL_CLIENT_ID',
      userPoolClient.userPoolClientId,
    );
    apiFunction.addEnvironment('PRODUCT_BASE_URL', webUrl);
    mcpFunction.addEnvironment('CHIEF_PRODUCT_BASE_URL', webUrl);

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(path.join(REPOSITORY_ROOT, 'apps/web/dist')),
      ],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    new cdk.CfnOutput(this, 'WebUrl', {
      value: webUrl,
    });
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'ApiHealthUrl', {
      value: `${httpApi.apiEndpoint}/trpc/system.health`,
    });
    new cdk.CfnOutput(this, 'McpUrl', {
      value: `${httpApi.apiEndpoint}/mcp`,
    });
    new cdk.CfnOutput(this, 'McpHealthUrl', {
      value: `${httpApi.apiEndpoint}/mcp/health`,
    });
    new cdk.CfnOutput(this, 'CloudFrontApiUrl', {
      value: `https://${distribution.distributionDomainName}/trpc`,
    });
    new cdk.CfnOutput(this, 'CloudFrontMcpUrl', {
      value: `https://${distribution.distributionDomainName}/mcp`,
    });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'CognitoUserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'CognitoIssuer', {
      value: cognitoIssuer,
    });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: userPoolDomain.baseUrl(),
    });
    new cdk.CfnOutput(this, 'BrowserLoginUrl', {
      value: `${webUrl}/auth/login`,
    });
  }

  private createLogGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createFunction(
    id: string,
    entry: string,
    serviceName: string,
    logGroup: logs.LogGroup,
    runtimeEnvironment: Record<string, string>,
  ): nodejs.NodejsFunction {
    return new nodejs.NodejsFunction(this, id, {
      entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(25),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        ...runtimeEnvironment,
        NODE_ENV: 'production',
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: serviceName,
        POWERTOOLS_METRICS_NAMESPACE: 'ChiefFoundation',
      },
      bundling: {
        target: 'node22',
        format: nodejs.OutputFormat.CJS,
        mainFields: ['module', 'main'],
        minify: true,
        sourceMap: true,
      },
      depsLockFilePath: path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'),
    });
  }

  private importRuntimeBindings(): RuntimeBindings {
    return {
      connectorRuntimeTableArn: cdk.Fn.importValue(
        runtimeExportNames.connectorRuntimeTableArn,
      ),
      connectorRuntimeTableName: cdk.Fn.importValue(
        runtimeExportNames.connectorRuntimeTableName,
      ),
      coreTableArn: cdk.Fn.importValue(runtimeExportNames.coreTableArn),
      coreTableName: cdk.Fn.importValue(runtimeExportNames.coreTableName),
      dataKeyArn: cdk.Fn.importValue(runtimeExportNames.dataKeyArn),
      retrievalTableArn: cdk.Fn.importValue(
        runtimeExportNames.retrievalTableArn,
      ),
      retrievalTableName: cdk.Fn.importValue(
        runtimeExportNames.retrievalTableName,
      ),
      snapshotBucketArn: cdk.Fn.importValue(
        runtimeExportNames.snapshotBucketArn,
      ),
      snapshotBucketName: cdk.Fn.importValue(
        runtimeExportNames.snapshotBucketName,
      ),
    };
  }

  private grantApiRuntimeAccess(
    function_: nodejs.NodejsFunction,
    runtime: RuntimeBindings,
  ): void {
    this.grantCoreTableData(function_, runtime.coreTableArn);
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DeleteItem', 'dynamodb:PutItem'],
        conditions: {
          StringEquals: {
            'dynamodb:EnclosingOperation': 'TransactWriteItems',
          },
        },
        resources: [runtime.coreTableArn],
      }),
    );
    this.grantTableData(
      function_,
      runtime.connectorRuntimeTableArn,
      'read-write',
    );
    this.grantTableData(function_, runtime.retrievalTableArn, 'read');
    this.grantSnapshotRead(function_, runtime.snapshotBucketArn);
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [runtime.dataKeyArn],
      }),
    );
  }

  private grantMcpRuntimeAccess(
    function_: nodejs.NodejsFunction,
    runtime: RuntimeBindings,
  ): void {
    this.grantCoreTableData(function_, runtime.coreTableArn);
    this.grantTableData(function_, runtime.retrievalTableArn, 'read');
    this.grantSnapshotRead(function_, runtime.snapshotBucketArn);
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [runtime.dataKeyArn],
      }),
    );
  }

  private grantTableData(
    function_: nodejs.NodejsFunction,
    tableArn: string,
    access: 'read' | 'read-write',
  ): void {
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:BatchGetItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:TransactGetItems',
        ],
        resources: [tableArn, `${tableArn}/index/*`],
      }),
    );
    if (access === 'read-write') {
      function_.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'dynamodb:ConditionCheckItem',
            'dynamodb:PutItem',
            'dynamodb:TransactWriteItems',
            'dynamodb:UpdateItem',
          ],
          resources: [tableArn],
        }),
      );
    }
  }

  private grantCoreTableData(
    function_: nodejs.NodejsFunction,
    tableArn: string,
  ): void {
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:TransactWriteItems'],
        resources: [tableArn],
      }),
    );
  }

  private grantSnapshotRead(
    function_: nodejs.NodejsFunction,
    snapshotBucketArn: string,
  ): void {
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [`${snapshotBucketArn}/*`],
      }),
    );
    function_.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetBucketLocation', 's3:ListBucket'],
        resources: [snapshotBucketArn],
      }),
    );
  }
}

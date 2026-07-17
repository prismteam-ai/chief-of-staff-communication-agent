import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const REPOSITORY_ROOT = path.resolve(process.cwd(), '../..');
const PROJECT_NAME = 'chief-communications';
const REPOSITORY_NAME = 'chief-of-staff-communication-agent';

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

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: cdk.Duration.seconds(0),
      })),
    });

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(path.join(REPOSITORY_ROOT, 'apps/web/dist')),
      ],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    const apiLogGroup = this.createLogGroup('ApiLogGroup');
    const mcpLogGroup = this.createLogGroup('McpLogGroup');

    const apiFunction = this.createFunction(
      'ApiFunction',
      path.join(REPOSITORY_ROOT, 'apps/api/src/handler.ts'),
      'chief-api',
      apiLogGroup,
    );
    const mcpFunction = this.createFunction(
      'McpFunction',
      path.join(REPOSITORY_ROOT, 'apps/mcp/src/handler.ts'),
      'chief-mcp',
      mcpLogGroup,
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT_NAME}-api`,
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowOrigins: ['*'],
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

    new cdk.CfnOutput(this, 'WebUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
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
  ): nodejs.NodejsFunction {
    return new nodejs.NodejsFunction(this, id, {
      entry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
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
}

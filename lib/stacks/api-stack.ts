import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { MetricsDashboard } from '../constructs/metrics-dashboard.js';
import { GitHubOidcDeployRole } from '../constructs/github-oidc-deploy-role.js';
import { PROJECT_NAME } from '../constructs/tags.js';
import { TaggedStack } from '../constructs/tagged-stack.js';

const SERVICE_NAME = 'chief-of-staff-api';
const METRICS_NAMESPACE = 'ChiefOfStaffApi';
const GITHUB_REPO = 'jzubielik/chief-of-staff-communication-agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_HANDLER_ENTRY = path.join(__dirname, '../../apps/api/src/handler.ts');

export class ApiStack extends TaggedStack {
  /** No custom domain — this account owns none; execute-api default URL is used (documented adaptation). */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = new nodejs.NodejsFunction(this, 'TrpcHandler', {
      entry: API_HANDLER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'TrpcHandlerLogGroup', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.ESM,
        banner:
          "import { createRequire as topLevelCreateRequire } from 'module'; const require = topLevelCreateRequire(import.meta.url);",
      },
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT_NAME}-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('LambdaIntegration', handler),
    });

    this.apiUrl = httpApi.apiEndpoint;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.apiUrl,
      description:
        'Default execute-api URL — no custom domain owned by this account (documented adaptation).',
    });

    const { dashboard } = new MetricsDashboard(this, 'ApiMetricsDashboard', {
      dashboardName: `${PROJECT_NAME}-api`,
      namespace: METRICS_NAMESPACE,
    });

    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });

    const { role: deployRole } = new GitHubOidcDeployRole(this, 'GitHubOidcDeployRole', {
      githubRepo: GITHUB_REPO,
      roleName: `${PROJECT_NAME}-github-actions-deploy`,
    });

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description:
        'Set as the AWS_DEPLOY_ROLE_ARN repository variable for ci-cd-dev.yml / ci-cd-prod.yml.',
    });
  }
}

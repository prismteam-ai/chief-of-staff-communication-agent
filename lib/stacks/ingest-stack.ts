import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as events from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';
import { DataTables } from '../constructs/data-tables.js';
import { DlqAlarm } from '../constructs/dlq-alarm.js';
import { MetricsDashboard } from '../constructs/metrics-dashboard.js';
import { PROJECT_NAME } from '../constructs/tags.js';

const SERVICE_NAME = 'chief-of-staff-ingest';
const METRICS_NAMESPACE = 'ChiefOfStaffIngest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLLER_HANDLER_ENTRY = path.join(__dirname, '../../apps/ingest/src/poller-handler.ts');
const PROCESSOR_HANDLER_ENTRY = path.join(__dirname, '../../apps/ingest/src/processor-handler.ts');

const BUNDLING: nodejs.BundlingOptions = {
  minify: true,
  sourceMap: true,
  target: 'node22',
  format: nodejs.OutputFormat.ESM,
  banner:
    "import { createRequire as topLevelCreateRequire } from 'module'; const require = topLevelCreateRequire(import.meta.url);",
};

/**
 * Owns the account model, communication-state, dedupe, and style-profile DynamoDB tables plus the
 * S3 raw-artifact bucket (design.md §5, §10; brief constraint 5) via the reusable `DataTables`
 * construct, and the Gmail ingest pipeline (brief constraint 3): EventBridge Scheduler
 * (rate(1 minute)) -> poller Lambda -> SQS (+DLQ, full alarm rule) -> processor Lambda -> dedupe +
 * persist + `MessageIngested`/`MessageFailed`/`ProcessingDuration` metrics.
 */
export class IngestStack extends TaggedStack {
  public readonly communicationsTableName: string;
  public readonly communicationsTableArn: string;
  public readonly accountsTableName: string;
  public readonly accountsTableArn: string;
  public readonly dedupeTableName: string;
  public readonly dedupeTableArn: string;
  public readonly styleProfilesTableName: string;
  public readonly styleProfilesTableArn: string;
  public readonly rawArtifactBucketName: string;
  public readonly rawArtifactBucketArn: string;
  public readonly ingestQueueUrl: string;
  public readonly ingestDlqUrl: string;
  public readonly processorFunctionName: string;
  public readonly pollerFunctionName: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tables = new DataTables(this, 'DataTables', { resourcePrefix: PROJECT_NAME });

    this.communicationsTableName = tables.communicationsTable.tableName;
    this.communicationsTableArn = tables.communicationsTable.tableArn;
    this.accountsTableName = tables.accountsTable.tableName;
    this.accountsTableArn = tables.accountsTable.tableArn;
    this.dedupeTableName = tables.dedupeTable.tableName;
    this.dedupeTableArn = tables.dedupeTable.tableArn;
    this.styleProfilesTableName = tables.styleProfilesTable.tableName;
    this.styleProfilesTableArn = tables.styleProfilesTable.tableArn;
    this.rawArtifactBucketName = tables.rawArtifactBucket.bucketName;
    this.rawArtifactBucketArn = tables.rawArtifactBucket.bucketArn;

    new cdk.CfnOutput(this, 'CommunicationsTableName', { value: this.communicationsTableName });
    new cdk.CfnOutput(this, 'AccountsTableName', { value: this.accountsTableName });
    new cdk.CfnOutput(this, 'DedupeTableName', { value: this.dedupeTableName });
    new cdk.CfnOutput(this, 'StyleProfilesTableName', { value: this.styleProfilesTableName });
    new cdk.CfnOutput(this, 'RawArtifactBucketName', { value: this.rawArtifactBucketName });

    // --- SQS: ingest queue + DLQ + the full alarm rule -------------------------------------

    const dlq = new sqs.Queue(this, 'IngestDlq', {
      queueName: `${PROJECT_NAME}-ingest-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      queueName: `${PROJECT_NAME}-ingest`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    this.ingestQueueUrl = ingestQueue.queueUrl;
    this.ingestDlqUrl = dlq.queueUrl;

    new cdk.CfnOutput(this, 'IngestQueueUrl', { value: this.ingestQueueUrl });
    new cdk.CfnOutput(this, 'IngestDlqUrl', { value: this.ingestDlqUrl });

    const { topic: dlqAlarmTopic } = new DlqAlarm(this, 'IngestDlqAlarm', {
      dlq,
      alarmName: `${PROJECT_NAME}-ingest-dlq-not-empty`,
      topicName: `${PROJECT_NAME}-ingest-dlq-alarm`,
    });

    new cdk.CfnOutput(this, 'IngestDlqAlarmTopicArn', {
      value: dlqAlarmTopic.topicArn,
      description:
        'No subscriptions wired yet — PagerDuty subscription is production-gated (Task 13).',
    });

    // --- Gmail OAuth secrets IAM scope --------------------------------------------------------

    // `cos/gmail-oauth-client` (operator-provisioned, shared) + `cos/gmail-token-*` (one per
    // connected mailbox, minted by `just gmail-auth`). Secrets Manager appends a random suffix to
    // the ARN, so a wildcard is required for a name-based grant.
    const gmailOAuthClientSecretArn = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'cos/gmail-oauth-client-??????',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const gmailTokenSecretArnPattern = cdk.Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'cos/gmail-token-*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    const gmailSecretsReadPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [gmailOAuthClientSecretArn, gmailTokenSecretArnPattern],
    });

    // --- Poller Lambda: EventBridge Scheduler (rate(1 minute)) -> history.list -> enqueue ----

    const pollerLogGroup = new logs.LogGroup(this, 'PollerHandlerLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pollerHandler = new nodejs.NodejsFunction(this, 'PollerHandler', {
      entry: POLLER_HANDLER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: pollerLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        ACCOUNTS_TABLE_NAME: this.accountsTableName,
        INGEST_QUEUE_URL: this.ingestQueueUrl,
      },
      bundling: BUNDLING,
    });

    tables.accountsTable.grantReadWriteData(pollerHandler);
    ingestQueue.grantSendMessages(pollerHandler);
    pollerHandler.addToRolePolicy(gmailSecretsReadPolicy);

    const schedulerRole = new iam.Role(this, 'PollerSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    pollerHandler.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, 'PollerSchedule', {
      scheduleExpression: 'rate(1 minute)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: pollerHandler.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    // --- Processor Lambda: SQS -> messages.get -> normalize -> dedupe -> persist -> metrics --

    const processorLogGroup = new logs.LogGroup(this, 'ProcessorHandlerLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processorHandler = new nodejs.NodejsFunction(this, 'ProcessorHandler', {
      entry: PROCESSOR_HANDLER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: processorLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        DEDUPE_TABLE_NAME: this.dedupeTableName,
        COMMUNICATIONS_TABLE_NAME: this.communicationsTableName,
        RAW_ARTIFACT_BUCKET_NAME: this.rawArtifactBucketName,
      },
      bundling: BUNDLING,
    });

    tables.dedupeTable.grantReadWriteData(processorHandler);
    tables.communicationsTable.grantReadWriteData(processorHandler);
    tables.rawArtifactBucket.grantWrite(processorHandler);
    processorHandler.addToRolePolicy(gmailSecretsReadPolicy);

    processorHandler.addEventSource(
      new events.SqsEventSource(ingestQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    this.processorFunctionName = processorHandler.functionName;
    this.pollerFunctionName = pollerHandler.functionName;

    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: this.processorFunctionName,
      description: 'Directly invokable by just verify-ingest to prove conditional-write dedupe.',
    });
    new cdk.CfnOutput(this, 'PollerFunctionName', { value: this.pollerFunctionName });

    // --- Dashboard -----------------------------------------------------------------------------

    const { dashboard } = new MetricsDashboard(this, 'IngestMetricsDashboard', {
      dashboardName: `${PROJECT_NAME}-ingest`,
      namespace: METRICS_NAMESPACE,
      processedMetricNames: ['MessageIngested'],
      failedMetricNames: ['MessageFailed'],
      titlePrefix: 'Ingest',
    });

    new cdk.CfnOutput(this, 'IngestDashboardName', { value: dashboard.dashboardName });
  }
}

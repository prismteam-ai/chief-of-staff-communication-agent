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
import type { RagStack } from './rag-stack.js';
import { AGENT_QUEUE_NAME } from './agent-stack.js';

const SERVICE_NAME = 'chief-of-staff-ingest';
const METRICS_NAMESPACE = 'ChiefOfStaffIngest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLLER_HANDLER_ENTRY = path.join(__dirname, '../../apps/ingest/src/poller-handler.ts');
const PROCESSOR_HANDLER_ENTRY = path.join(__dirname, '../../apps/ingest/src/processor-handler.ts');

export interface IngestStackProps extends cdk.StackProps {
  /**
   * The RAG knowledge-layer domain (design.md §4, brief constraint 8: "Wire the domain endpoint +
   * IAM ... once CREATE completes"). Optional so IngestStack still synthesizes/deploys standalone
   * before RagStack exists — the processor Lambda then runs with `RAG_DOMAIN_ENDPOINT` unset,
   * which `processor-handler.ts`'s `unwiredRetrievalIndex` degrades gracefully from (isolated
   * failure, `ChunkIndexFailed`, ingestion unaffected).
   */
  readonly ragStack?: RagStack;
}

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
  public readonly mcpTokensTableName: string;
  public readonly mcpTokensTableArn: string;
  public readonly rawArtifactBucketName: string;
  public readonly rawArtifactBucketArn: string;
  public readonly ingestQueueUrl: string;
  public readonly ingestDlqUrl: string;
  public readonly processorFunctionName: string;
  public readonly pollerFunctionName: string;

  constructor(scope: Construct, id: string, props?: IngestStackProps) {
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
    this.mcpTokensTableName = tables.mcpTokensTable.tableName;
    this.mcpTokensTableArn = tables.mcpTokensTable.tableArn;
    this.rawArtifactBucketName = tables.rawArtifactBucket.bucketName;
    this.rawArtifactBucketArn = tables.rawArtifactBucket.bucketArn;

    new cdk.CfnOutput(this, 'CommunicationsTableName', { value: this.communicationsTableName });
    new cdk.CfnOutput(this, 'AccountsTableName', { value: this.accountsTableName });
    new cdk.CfnOutput(this, 'DedupeTableName', { value: this.dedupeTableName });
    new cdk.CfnOutput(this, 'StyleProfilesTableName', { value: this.styleProfilesTableName });
    new cdk.CfnOutput(this, 'McpTokensTableName', { value: this.mcpTokensTableName });
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

    // --- Agent queue references (deterministic name — see AGENT_QUEUE_URL note below) ---------

    // AgentStack owns the queue; ingest only publishes to it. Referencing it by ARN/URL built from
    // the shared deterministic name (not a construct import) keeps Ingest and Agent free of a
    // CloudFormation dependency cycle.
    const agentQueueArn = cdk.Stack.of(this).formatArn({
      service: 'sqs',
      resource: AGENT_QUEUE_NAME,
    });
    const agentQueueUrl = `https://sqs.${this.region}.amazonaws.com/${this.account}/${AGENT_QUEUE_NAME}`;

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
        // Agent trigger (Task 5): the processor publishes {commId, accountId} here after persist.
        // Built from the deterministic AGENT_QUEUE_NAME, NOT a construct ref to AgentStack — that
        // would create an Ingest↔Agent CloudFormation cycle (AgentStack already imports this
        // stack's communications table). AgentStack owns the queue; this is the same
        // name-then-formatArn pattern used for the Gmail secret ARNs above.
        AGENT_QUEUE_URL: agentQueueUrl,
        ...(props?.ragStack ? { RAG_DOMAIN_ENDPOINT: props.ragStack.domainEndpoint } : {}),
      },
      bundling: BUNDLING,
    });

    tables.dedupeTable.grantReadWriteData(processorHandler);
    tables.communicationsTable.grantReadWriteData(processorHandler);
    tables.rawArtifactBucket.grantWrite(processorHandler);
    processorHandler.addToRolePolicy(gmailSecretsReadPolicy);
    // Grant SendMessage on the agent queue by its deterministic ARN (see AGENT_QUEUE_URL note).
    processorHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [agentQueueArn],
      }),
    );

    // RAG knowledge-layer wiring (design.md §4, brief constraint 8): grants the processor's
    // execution role `es:ESHttp*` on the domain (identity-side; the domain's own access policy is
    // account-root-scoped — see rag-stack.ts — so this identity grant is what actually authorizes
    // the SigV4-signed calls `rag-index-step.ts` makes) and Bedrock InvokeModel on the pinned
    // Cohere Embed v4 inference profile.
    if (props?.ragStack) {
      props.ragStack.grantIndexAccess(processorHandler);
      processorHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'bedrock',
              region: 'us-east-2',
              resource: 'inference-profile',
              resourceName: 'us.cohere.embed-v4:0',
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
            // The inference profile forwards to regional foundation-model ARNs across the `us.`
            // profile's member regions — grant the wildcard foundation-model resource so the
            // profile's actual routing target is always covered without hand-listing each region.
            `arn:aws:bedrock:*::foundation-model/cohere.embed-v4:0`,
          ],
        }),
      );
    }

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

    // RAG chunk-indexing metrics (design.md §4, brief constraint 4) ride the same "processed vs
    // failed" graph as the message-ingest metrics — `MetricsDashboard` already takes an array of
    // metric names per side, so ChunkIndexed/ChunkIndexFailed need no new dashboard construct.
    const { dashboard } = new MetricsDashboard(this, 'IngestMetricsDashboard', {
      dashboardName: `${PROJECT_NAME}-ingest`,
      namespace: METRICS_NAMESPACE,
      processedMetricNames: ['MessageIngested', 'ChunkIndexed'],
      failedMetricNames: ['MessageFailed', 'ChunkIndexFailed'],
      titlePrefix: 'Ingest',
    });

    new cdk.CfnOutput(this, 'IngestDashboardName', { value: dashboard.dashboardName });
  }
}

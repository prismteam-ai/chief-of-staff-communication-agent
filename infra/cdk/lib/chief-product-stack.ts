import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import { runtimeExportNames } from './runtime-exports.js';

const REPOSITORY_ROOT = path.resolve(process.cwd(), '../..');
const PROJECT_NAME = 'chief-communications';
const REPOSITORY_NAME = 'chief-of-staff-communication-agent';

const coreIndexes = {
  asanaTopicLookup: 'AsanaTopicLookupIndex',
  correlation: 'CorrelationIndex',
  identityLookup: 'IdentityLookupIndex',
  sla: 'SlaIndex',
  threadLookup: 'ThreadLookupIndex',
  workQueue: 'WorkQueueIndex',
} as const;

const connectorIndexes = {
  outbox: 'OutboxIndex',
  leaseRenewal: 'LeaseRenewalIndex',
} as const;

const ingestionConnectorBindings =
  'gmail=gmail@1.0.0,microsoft_graph=microsoft-graph@1.0.0-wave1a,imap=imap-smtp@1.0.0-protocol,twilio_sms=twilio-sms@1.0.0,twilio_whatsapp=twilio-whatsapp@1.0.0,x=x_legacy_dm@1.0.0,linkedin_archive=linkedin-communications@1.0.0-scaffold,asana=asana-work-management@1.0.0';

export class ChiefProductStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const ingestionGsiStage = Number(
      this.node.tryGetContext('ingestionGsiStage') ?? 3,
    );
    if (![1, 2, 3].includes(ingestionGsiStage)) {
      throw new TypeError('ingestionGsiStage must be 1, 2, or 3');
    }

    cdk.Tags.of(this).add('project_name', PROJECT_NAME);
    cdk.Tags.of(this).add('repository', REPOSITORY_NAME);
    cdk.Tags.of(this).add('external_effects', 'disabled');

    const dataKey = new kms.Key(this, 'ProductDataKey', {
      alias: 'alias/chief-communications-product-data',
      description:
        'Customer-managed key for Chief operational, retrieval, and queue data.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pendingWindow: cdk.Duration.days(30),
    });

    const coreTable = this.createTable('CoreDomainTable', dataKey);
    coreTable.addGlobalSecondaryIndex({
      indexName: coreIndexes.workQueue,
      partitionKey: { name: 'gsiWorkPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiWorkSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        'entityType',
        'status',
        'nextAttemptAtEpochMs',
        'slaDeadlineEpochMs',
      ],
    });
    coreTable.addGlobalSecondaryIndex({
      indexName: coreIndexes.correlation,
      partitionKey: {
        name: 'gsiCorrelationPk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'gsiCorrelationSk',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    coreTable.addGlobalSecondaryIndex({
      indexName: coreIndexes.sla,
      partitionKey: { name: 'gsiSlaPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiSlaSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    if (ingestionGsiStage >= 1) {
      coreTable.addGlobalSecondaryIndex({
        indexName: coreIndexes.threadLookup,
        partitionKey: {
          name: 'threadLookupKey',
          type: dynamodb.AttributeType.STRING,
        },
        projectionType: dynamodb.ProjectionType.INCLUDE,
        nonKeyAttributes: [
          'deleted',
          'direction',
          'messageId',
          'revisionId',
          'sourceTimestamp',
        ],
      });
    }
    if (ingestionGsiStage >= 2) {
      coreTable.addGlobalSecondaryIndex({
        indexName: coreIndexes.identityLookup,
        partitionKey: {
          name: 'identityLookupKey',
          type: dynamodb.AttributeType.STRING,
        },
        projectionType: dynamodb.ProjectionType.INCLUDE,
        nonKeyAttributes: ['accountId', 'personId', 'revisionId'],
      });
    }
    if (ingestionGsiStage >= 3) {
      coreTable.addGlobalSecondaryIndex({
        indexName: coreIndexes.asanaTopicLookup,
        partitionKey: {
          name: 'asanaTopicLookupKey',
          type: dynamodb.AttributeType.STRING,
        },
        projectionType: dynamodb.ProjectionType.INCLUDE,
        nonKeyAttributes: ['dedupeKey', 'providerObjectId'],
      });
    }

    const connectorRuntimeTable = this.createTable(
      'ConnectorRuntimeTable',
      dataKey,
    );
    connectorRuntimeTable.addGlobalSecondaryIndex({
      indexName: connectorIndexes.outbox,
      partitionKey: {
        name: 'gsiOutboxPk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'gsiOutboxSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        'status',
        'nextAttemptAtEpochMs',
        'claimExpiresAtEpochMs',
        'operationId',
      ],
    });
    connectorRuntimeTable.addGlobalSecondaryIndex({
      indexName: connectorIndexes.leaseRenewal,
      partitionKey: { name: 'gsiLeasePk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiLeaseSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    const retrievalTable = this.createTable('RetrievalTable', dataKey);
    retrievalTable.addGlobalSecondaryIndex({
      indexName: 'FactualHeadIndex',
      partitionKey: {
        name: 'gsiFactualPk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'gsiFactualSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    retrievalTable.addGlobalSecondaryIndex({
      indexName: 'StyleHeadIndex',
      partitionKey: { name: 'gsiStylePk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiStyleSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    retrievalTable.addGlobalSecondaryIndex({
      indexName: 'AuthorizationEpochIndex',
      partitionKey: { name: 'gsiEpochPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiEpochSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    const snapshotBucket = new s3.Bucket(this, 'SnapshotBlobBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
        cdk.Duration.days(365),
      ),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const ingestionDlq = this.createDeadLetterQueue(
      'IngestionDeadLetterQueue',
      dataKey,
    );
    const ingestionQueue = this.createWorkQueue(
      'IngestionQueue',
      ingestionDlq,
      dataKey,
    );
    const outboxDlq = this.createDeadLetterQueue(
      'OutboxDeadLetterQueue',
      dataKey,
    );
    const outboxQueue = this.createWorkQueue('OutboxQueue', outboxDlq, dataKey);

    const alertTopicName = `${PROJECT_NAME}-runtime-alerts`;
    const alertTopicArn = this.formatArn({
      resource: alertTopicName,
      service: 'sns',
    });
    const alertTopic = new sns.Topic(this, 'RuntimeAlertTopic', {
      displayName: 'Chief runtime state changes',
      masterKey: dataKey,
      topicName: alertTopicName,
    });
    const cloudWatchPrincipal = new iam.ServicePrincipal(
      'cloudwatch.amazonaws.com',
    );
    const alarmArnPattern = `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:*`;
    alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        conditions: {
          ArnLike: { 'aws:SourceArn': alarmArnPattern },
          StringEquals: { 'aws:SourceAccount': this.account },
        },
        principals: [cloudWatchPrincipal],
        resources: [alertTopic.topicArn],
      }),
    );
    dataKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        conditions: {
          ArnEquals: { 'aws:SourceArn': alertTopicArn },
          StringEquals: {
            'aws:SourceAccount': this.account,
            'kms:EncryptionContext:aws:sns:topicArn': alertTopicArn,
          },
        },
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        resources: ['*'],
      }),
    );
    this.createDeadLetterAlarm(
      'IngestionDeadLetterAlarm',
      ingestionDlq,
      alertTopic,
    );
    this.createDeadLetterAlarm('OutboxDeadLetterAlarm', outboxDlq, alertTopic);

    const productBus = new events.EventBus(this, 'ProductEventBus', {
      kmsKey: dataKey,
    });
    new events.Rule(this, 'IngestionRequestedRule', {
      eventBus: productBus,
      description:
        'Routes verified canonical ingestion requests into the bounded worker queue.',
      eventPattern: {
        source: ['chief.connectors'],
        detailType: ['communication.ingest.requested'],
      },
      targets: [
        new eventTargets.SqsQueue(ingestionQueue, {
          deadLetterQueue: ingestionDlq,
          maxEventAge: cdk.Duration.hours(1),
          retryAttempts: 3,
        }),
      ],
    });

    const digestKeySecret = new secretsmanager.Secret(this, 'DigestKeySecret', {
      description:
        'Versioned HMAC key material for tenant-bound provider identifier digests.',
      encryptionKey: dataKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ version: 'v1' }),
        generateStringKey: 'key',
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    const effectDisabledEnvironment = {
      EXTERNAL_EFFECTS: 'disabled',
      MODEL_EFFECTS: 'disabled',
      PROVIDER_EFFECTS: 'disabled',
      WORK_MANAGEMENT_EFFECTS: 'disabled',
    } as const;
    const commonEnvironment = {
      CORE_TABLE_NAME: coreTable.tableName,
      CONNECTOR_RUNTIME_TABLE_NAME: connectorRuntimeTable.tableName,
      RETRIEVAL_TABLE_NAME: retrievalTable.tableName,
      SNAPSHOT_BUCKET_NAME: snapshotBucket.bucketName,
      INGESTION_QUEUE_URL: ingestionQueue.queueUrl,
      OUTBOX_QUEUE_URL: outboxQueue.queueUrl,
      PRODUCT_EVENT_BUS_NAME: productBus.eventBusName,
      DIGEST_KEY_SECRET_ARN: digestKeySecret.secretArn,
      ...effectDisabledEnvironment,
      POWERTOOLS_METRICS_NAMESPACE: 'ChiefProduct',
    };
    const ingestionEnvironment = {
      CONNECTOR_RUNTIME_TABLE_NAME: connectorRuntimeTable.tableName,
      CORE_TABLE_NAME: coreTable.tableName,
      DIGEST_KEY_SECRET_ARN: digestKeySecret.secretArn,
      ...effectDisabledEnvironment,
      INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME: coreIndexes.asanaTopicLookup,
      INGESTION_CONNECTOR_BINDINGS: ingestionConnectorBindings,
      INGESTION_IDENTITY_LOOKUP_INDEX_NAME: coreIndexes.identityLookup,
      INGESTION_RUNTIME_MODE: 'production',
      INGESTION_THREAD_LOOKUP_INDEX_NAME: coreIndexes.threadLookup,
      POWERTOOLS_METRICS_NAMESPACE: 'ChiefProduct',
      PRODUCT_DATA_KEY_ARN: dataKey.keyArn,
      RETRIEVAL_TABLE_NAME: retrievalTable.tableName,
      SNAPSHOT_BUCKET_NAME: snapshotBucket.bucketName,
    };

    const ingestionWorker = this.createWorker(
      'IngestionWorker',
      'apps/ingestion-worker/src/handler.ts',
      'chief-ingestion-worker',
      ingestionEnvironment,
    );
    ingestionWorker.addEventSource(
      new eventSources.SqsEventSource(ingestionQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );
    const executionWorker = this.createWorker(
      'ExecutionWorker',
      'apps/execution-worker/src/handler.ts',
      'chief-execution-worker',
      commonEnvironment,
    );
    executionWorker.addEventSource(
      new eventSources.SqsEventSource(outboxQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );

    this.grantTableData(ingestionWorker, coreTable, 'read-write');
    this.grantTableData(ingestionWorker, connectorRuntimeTable, 'read-write');
    this.grantTableData(ingestionWorker, retrievalTable, 'read-write');
    snapshotBucket.grantRead(ingestionWorker);
    snapshotBucket.grantPut(ingestionWorker);
    ingestionQueue.grantConsumeMessages(ingestionWorker);
    digestKeySecret.grantRead(ingestionWorker);

    this.grantTableData(executionWorker, coreTable, 'read-write');
    this.grantTableData(executionWorker, connectorRuntimeTable, 'read-write');
    this.grantTableData(executionWorker, retrievalTable, 'read');
    snapshotBucket.grantRead(executionWorker);
    outboxQueue.grantConsumeMessages(executionWorker);
    productBus.grantPutEventsTo(executionWorker);
    digestKeySecret.grantRead(executionWorker);

    this.createExport(
      'CoreTableName',
      coreTable.tableName,
      runtimeExportNames.coreTableName,
    );
    this.createExport(
      'CoreTableArn',
      coreTable.tableArn,
      runtimeExportNames.coreTableArn,
    );
    this.createExport(
      'ConnectorRuntimeTableName',
      connectorRuntimeTable.tableName,
      runtimeExportNames.connectorRuntimeTableName,
    );
    this.createExport(
      'ConnectorRuntimeTableArn',
      connectorRuntimeTable.tableArn,
      runtimeExportNames.connectorRuntimeTableArn,
    );
    this.createExport(
      'RetrievalTableName',
      retrievalTable.tableName,
      runtimeExportNames.retrievalTableName,
    );
    this.createExport(
      'RetrievalTableArn',
      retrievalTable.tableArn,
      runtimeExportNames.retrievalTableArn,
    );
    this.createExport(
      'SnapshotBucketName',
      snapshotBucket.bucketName,
      runtimeExportNames.snapshotBucketName,
    );
    this.createExport(
      'SnapshotBucketArn',
      snapshotBucket.bucketArn,
      runtimeExportNames.snapshotBucketArn,
    );
    this.createExport(
      'IngestionQueueUrl',
      ingestionQueue.queueUrl,
      runtimeExportNames.ingestionQueueUrl,
    );
    this.createExport(
      'IngestionQueueArn',
      ingestionQueue.queueArn,
      runtimeExportNames.ingestionQueueArn,
    );
    this.createExport(
      'OutboxQueueUrl',
      outboxQueue.queueUrl,
      runtimeExportNames.outboxQueueUrl,
    );
    this.createExport(
      'OutboxQueueArn',
      outboxQueue.queueArn,
      runtimeExportNames.outboxQueueArn,
    );
    this.createExport(
      'ProductEventBusName',
      productBus.eventBusName,
      runtimeExportNames.productEventBusName,
    );
    this.createExport(
      'ProductEventBusArn',
      productBus.eventBusArn,
      runtimeExportNames.productEventBusArn,
    );
    this.createExport(
      'DigestKeySecretArn',
      digestKeySecret.secretArn,
      runtimeExportNames.digestKeySecretArn,
    );
    this.createExport(
      'ProductDataKeyArn',
      dataKey.keyArn,
      runtimeExportNames.dataKeyArn,
    );
    new cdk.CfnOutput(this, 'RuntimeAlertTopicArn', {
      value: alertTopic.topicArn,
    });
    new cdk.CfnOutput(this, 'IngestionDeadLetterQueueUrl', {
      value: ingestionDlq.queueUrl,
    });
    new cdk.CfnOutput(this, 'OutboxDeadLetterQueueUrl', {
      value: outboxDlq.queueUrl,
    });

    const foundationStack = scope.node.tryFindChild('ChiefFoundationStack');
    if (foundationStack instanceof cdk.Stack) {
      foundationStack.addDependency(this);
    }
  }

  private createDeadLetterQueue(id: string, dataKey: kms.IKey): sqs.Queue {
    return new sqs.Queue(this, id, {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
  }

  private createWorkQueue(
    id: string,
    deadLetterQueue: sqs.IQueue,
    dataKey: kms.IKey,
  ): sqs.Queue {
    return new sqs.Queue(this, id, {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      visibilityTimeout: cdk.Duration.minutes(6),
      retentionPeriod: cdk.Duration.days(4),
      maxMessageSizeBytes: 256 * 1024,
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
    });
  }

  private createDeadLetterAlarm(
    id: string,
    queue: sqs.IQueue,
    topic: sns.ITopic,
  ): void {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmDescription:
        'The queue contains terminal failures. Triage and redrive; the alarm clears when drained.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const action = new cloudwatchActions.SnsAction(topic);
    alarm.addAlarmAction(action);
    alarm.addOkAction(action);
  }

  private createExport(id: string, value: string, exportName: string): void {
    new cdk.CfnOutput(this, id, { exportName, value });
  }

  private createTable(id: string, encryptionKey: kms.IKey): dynamodb.Table {
    return new dynamodb.Table(this, id, {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  private grantTableData(
    grantee: iam.IGrantable,
    table: dynamodb.ITable,
    access: 'read' | 'read-write',
  ): void {
    const actions = [
      'dynamodb:BatchGetItem',
      'dynamodb:DescribeTable',
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:TransactGetItems',
    ];
    if (access === 'read-write') {
      actions.push(
        'dynamodb:ConditionCheckItem',
        'dynamodb:PutItem',
        'dynamodb:TransactWriteItems',
        'dynamodb:UpdateItem',
      );
    }
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions,
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );
  }

  private createWorker(
    id: string,
    relativeEntry: string,
    serviceName: string,
    environment: Record<string, string>,
  ): nodejs.NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    return new nodejs.NodejsFunction(this, id, {
      entry: path.join(REPOSITORY_ROOT, relativeEntry),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      logGroup,
      environment: {
        ...environment,
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: serviceName,
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

import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const REPOSITORY_ROOT = path.resolve(process.cwd(), '../..');
const PROJECT_NAME = 'chief-communications';
const REPOSITORY_NAME = 'chief-of-staff-communication-agent';

const coreIndexes = {
  workQueue: 'WorkQueueIndex',
  correlation: 'CorrelationIndex',
  sla: 'SlaIndex',
} as const;

const connectorIndexes = {
  outbox: 'OutboxIndex',
  leaseRenewal: 'LeaseRenewalIndex',
} as const;

export class ChiefProductStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

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

    const outboxDlq = new sqs.Queue(this, 'OutboxDeadLetterQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const outboxQueue = new sqs.Queue(this, 'OutboxQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dataKey,
      visibilityTimeout: cdk.Duration.minutes(2),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: outboxDlq, maxReceiveCount: 5 },
    });

    const productBus = new events.EventBus(this, 'ProductEventBus');
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

    const commonEnvironment = {
      CORE_TABLE_NAME: coreTable.tableName,
      CONNECTOR_RUNTIME_TABLE_NAME: connectorRuntimeTable.tableName,
      RETRIEVAL_TABLE_NAME: retrievalTable.tableName,
      SNAPSHOT_BUCKET_NAME: snapshotBucket.bucketName,
      OUTBOX_QUEUE_URL: outboxQueue.queueUrl,
      PRODUCT_EVENT_BUS_NAME: productBus.eventBusName,
      DIGEST_KEY_SECRET_ARN: digestKeySecret.secretArn,
      EXTERNAL_EFFECTS: 'disabled',
      POWERTOOLS_METRICS_NAMESPACE: 'ChiefProduct',
    };

    const ingestionWorker = this.createWorker(
      'IngestionWorker',
      'apps/ingestion-worker/src/handler.ts',
      'chief-ingestion-worker',
      commonEnvironment,
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
        reportBatchItemFailures: true,
      }),
    );

    this.grantTableData(ingestionWorker, coreTable, 'read-write');
    this.grantTableData(ingestionWorker, connectorRuntimeTable, 'read-write');
    this.grantTableData(ingestionWorker, retrievalTable, 'read-write');
    snapshotBucket.grantRead(ingestionWorker);
    snapshotBucket.grantPut(ingestionWorker);
    outboxQueue.grantSendMessages(ingestionWorker);
    productBus.grantPutEventsTo(ingestionWorker);
    digestKeySecret.grantRead(ingestionWorker);

    this.grantTableData(executionWorker, coreTable, 'read-write');
    this.grantTableData(executionWorker, connectorRuntimeTable, 'read-write');
    this.grantTableData(executionWorker, retrievalTable, 'read');
    snapshotBucket.grantRead(executionWorker);
    outboxQueue.grantConsumeMessages(executionWorker);
    productBus.grantPutEventsTo(executionWorker);
    digestKeySecret.grantRead(executionWorker);

    new cdk.CfnOutput(this, 'CoreTableName', { value: coreTable.tableName });
    new cdk.CfnOutput(this, 'ConnectorRuntimeTableName', {
      value: connectorRuntimeTable.tableName,
    });
    new cdk.CfnOutput(this, 'RetrievalTableName', {
      value: retrievalTable.tableName,
    });
    new cdk.CfnOutput(this, 'SnapshotBucketName', {
      value: snapshotBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'OutboxQueueUrl', { value: outboxQueue.queueUrl });
    new cdk.CfnOutput(this, 'ProductEventBusName', {
      value: productBus.eventBusName,
    });
    new cdk.CfnOutput(this, 'DigestKeySecretArn', {
      value: digestKeySecret.secretArn,
    });
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
    ];
    if (access === 'read-write') {
      actions.push(
        'dynamodb:ConditionCheckItem',
        'dynamodb:PutItem',
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
      logGroup,
      environment: {
        ...environment,
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: serviceName,
      },
      bundling: {
        target: 'node22',
        format: nodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
        minify: true,
        sourceMap: true,
        banner:
          'import { createRequire } from "module";const require = createRequire(import.meta.url);',
      },
      depsLockFilePath: path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'),
    });
  }
}

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ChiefFoundationStack } from '../lib/chief-foundation-stack.js';
import { ChiefProductStack } from '../lib/chief-product-stack.js';

function createProductTemplate(ingestionGsiStage?: number): Template {
  const app = new cdk.App({
    context: ingestionGsiStage === undefined ? {} : { ingestionGsiStage },
  });
  const stack = new ChiefProductStack(app, 'TestChiefProduct', {
    env: { account: '417242953053', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

const template = createProductTemplate();

interface SynthesizedIndex {
  readonly IndexName: string;
  readonly Projection: {
    readonly ProjectionType: string;
    readonly NonKeyAttributes?: readonly string[];
  };
}

interface SynthesizedWorkerResource {
  readonly Properties?: {
    readonly ReservedConcurrentExecutions?: number;
  };
}

interface SynthesizedTemplate {
  readonly Resources: Record<
    string,
    {
      readonly Type: string;
      readonly Properties?: {
        readonly Code?: { readonly S3Key?: unknown };
        readonly Environment?: {
          readonly Variables?: {
            readonly POWERTOOLS_SERVICE_NAME?: unknown;
          };
        };
        readonly Runtime?: unknown;
      };
    }
  >;
}

const require = createRequire(import.meta.url);

function workerLambdaBundles(
  synthesizedTemplate: SynthesizedTemplate,
  outputDirectory: string,
): Map<string, string> {
  const bundles = new Map<string, string>();

  for (const resource of Object.values(synthesizedTemplate.Resources)) {
    const serviceName =
      resource.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME;
    if (
      resource.Type !== 'AWS::Lambda::Function' ||
      resource.Properties?.Runtime !== 'nodejs22.x' ||
      (serviceName !== 'chief-ingestion-worker' &&
        serviceName !== 'chief-execution-worker' &&
        serviceName !== 'chief-outbox-relay')
    ) {
      continue;
    }

    const assetKey = resource.Properties.Code?.S3Key;
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

  expect([...bundles.keys()].sort()).toEqual([
    'chief-execution-worker',
    'chief-ingestion-worker',
    'chief-outbox-relay',
  ]);
  return bundles;
}

function allActions(): readonly string[] {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as Array<{
    Properties?: {
      PolicyDocument?: {
        Statement?: Array<{ Action?: string | string[] }>;
      };
    };
  }>;
  return policies.flatMap((policy) =>
    (policy.Properties?.PolicyDocument?.Statement ?? []).flatMap(
      ({ Action }) => (Array.isArray(Action) ? Action : Action ? [Action] : []),
    ),
  );
}

function allPolicyStatements(): Array<{
  readonly Action?: string | string[];
  readonly Condition?: unknown;
  readonly Effect?: string;
  readonly Resource?: unknown;
}> {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as Array<{
    Properties?: {
      PolicyDocument?: {
        Statement?: Array<{
          readonly Action?: string | string[];
          readonly Condition?: unknown;
          readonly Effect?: string;
          readonly Resource?: unknown;
        }>;
      };
    };
  }>;
  return policies.flatMap(
    (policy) => policy.Properties?.PolicyDocument?.Statement ?? [],
  );
}

function workerPolicyStatements(
  functionId: 'ExecutionWorker' | 'IngestionWorker' | 'OutboxRelayWorker',
): Array<{
  readonly Action?: string | string[];
  readonly Condition?: unknown;
  readonly Effect?: string;
  readonly Resource?: unknown;
}> {
  const policies = Object.entries(
    template.findResources('AWS::IAM::Policy'),
  ).filter(([logicalId]) =>
    logicalId.includes(`${functionId}ServiceRoleDefaultPolicy`),
  ) as Array<
    [
      string,
      {
        readonly Properties?: {
          readonly PolicyDocument?: {
            readonly Statement?: Array<{
              readonly Action?: string | string[];
              readonly Condition?: unknown;
              readonly Effect?: string;
              readonly Resource?: unknown;
            }>;
          };
        };
      },
    ]
  >;
  expect(policies).toHaveLength(1);
  return policies[0]?.[1].Properties?.PolicyDocument?.Statement ?? [];
}

function expectCdkReference(value: unknown): void {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  if (typeof value !== 'object' || value === null)
    throw new Error('Expected a synthesized CloudFormation reference.');
  expect(
    'Ref' in value ||
      ('Fn::GetAtt' in value && Array.isArray(value['Fn::GetAtt'])),
  ).toBe(true);
}

describe('Chief product stack', () => {
  it('supports one-index-at-a-time production GSI migration waves', () => {
    const newIndexes = [
      'ThreadLookupIndex',
      'IdentityLookupIndex',
      'AsanaTopicLookupIndex',
    ];
    for (const stage of [1, 2, 3]) {
      const stageTemplate = createProductTemplate(stage);
      const tables = Object.values(
        stageTemplate.findResources('AWS::DynamoDB::Table'),
      ) as Array<{
        readonly Properties?: {
          readonly GlobalSecondaryIndexes?: readonly SynthesizedIndex[];
        };
      }>;
      const names = tables.flatMap(({ Properties }) =>
        (Properties?.GlobalSecondaryIndexes ?? []).map(
          ({ IndexName }) => IndexName,
        ),
      );
      expect(names.filter((name) => newIndexes.includes(name))).toEqual(
        newIndexes.slice(0, stage),
      );
    }
  }, 60_000);

  it('rejects invalid production GSI migration stages', () => {
    expect(() => createProductTemplate(0)).toThrow(
      'ingestionGsiStage must be 1, 2, or 3',
    );
  });

  it('creates exactly three on-demand, KMS-encrypted, PITR domain tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
    template.resourcePropertiesCountIs(
      'AWS::DynamoDB::Table',
      {
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: Match.objectLike({
          SSEEnabled: true,
          SSEType: 'KMS',
        }),
        DeletionProtectionEnabled: true,
      },
      3,
    );
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
    template.resourcePropertiesCountIs(
      'AWS::DynamoDB::Table',
      { StreamSpecification: { StreamViewType: 'NEW_IMAGE' } },
      1,
    );
  });

  it('asserts the exact projection allowlist for every named index', () => {
    const tables = Object.values(
      template.findResources('AWS::DynamoDB::Table'),
    ) as Array<{
      Properties?: { GlobalSecondaryIndexes?: SynthesizedIndex[] };
    }>;
    const indexes = new Map(
      tables
        .flatMap((table) => table.Properties?.GlobalSecondaryIndexes ?? [])
        .map((index) => [index.IndexName, index.Projection] as const),
    );
    expect(Object.fromEntries(indexes)).toEqual({
      WorkQueueIndex: {
        ProjectionType: 'INCLUDE',
        NonKeyAttributes: [
          'entityType',
          'status',
          'nextAttemptAtEpochMs',
          'slaDeadlineEpochMs',
        ],
      },
      CorrelationIndex: { ProjectionType: 'KEYS_ONLY' },
      SlaIndex: { ProjectionType: 'KEYS_ONLY' },
      OutboxIndex: {
        ProjectionType: 'INCLUDE',
        NonKeyAttributes: [
          'status',
          'nextAttemptAtEpochMs',
          'claimExpiresAtEpochMs',
          'operationId',
        ],
      },
      LeaseRenewalIndex: { ProjectionType: 'KEYS_ONLY' },
      FactualHeadIndex: { ProjectionType: 'KEYS_ONLY' },
      StyleHeadIndex: { ProjectionType: 'KEYS_ONLY' },
      AuthorizationEpochIndex: { ProjectionType: 'KEYS_ONLY' },
      ThreadLookupIndex: {
        ProjectionType: 'INCLUDE',
        NonKeyAttributes: [
          'deleted',
          'direction',
          'messageId',
          'revisionId',
          'sourceTimestamp',
        ],
      },
      IdentityLookupIndex: {
        ProjectionType: 'INCLUDE',
        NonKeyAttributes: ['accountId', 'personId', 'revisionId'],
      },
      AsanaTopicLookupIndex: {
        ProjectionType: 'INCLUDE',
        NonKeyAttributes: ['dedupeKey', 'providerObjectId'],
      },
    });
  });

  it('enforces private, encrypted, versioned Object Lock storage', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: { Mode: 'COMPLIANCE', Days: 365 },
        },
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
            }),
          }),
        ],
      },
    });
  });

  it('retains complete relay failures in a private account-scoped S3 destination', () => {
    template.resourcePropertiesCountIs(
      'AWS::S3::Bucket',
      {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({
              BucketKeyEnabled: true,
              ServerSideEncryptionByDefault: Match.objectLike({
                SSEAlgorithm: 'aws:kms',
              }),
            }),
          ],
        },
        MetricsConfigurations: [{ Id: 'OutboxRelayFailureCaptures' }],
        OwnershipControls: {
          Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: 'Enabled' },
      },
      1,
    );
    const failureBuckets = Object.entries(
      template.findResources('AWS::S3::Bucket'),
    ).filter(([, resource]) =>
      JSON.stringify(resource).includes('OutboxRelayFailureCaptures'),
    );
    expect(failureBuckets).toHaveLength(1);
    const [failureBucketLogicalId, failureBucket] = failureBuckets[0] ?? [];
    expect(failureBucket).toMatchObject({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: failureBucketLogicalId },
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Effect: 'Deny',
          }),
        ]),
      },
    });
    const outputs = template.toJSON().Outputs as Record<string, unknown>;
    expect(outputs.OutboxRelayFailureBucketName).toEqual({
      Value: { Ref: failureBucketLogicalId },
    });
    expect(outputs.OutboxRelayDeadLetterQueueUrl).toBeUndefined();
  });

  it('creates encrypted queues, redrive, event routing, and self-resolving DLQ alarms', () => {
    template.resourceCountIs('AWS::SQS::Queue', 4);
    template.resourcePropertiesCountIs(
      'AWS::SQS::Queue',
      { KmsMasterKeyId: Match.anyValue() },
      4,
    );
    template.resourcePropertiesCountIs(
      'AWS::SQS::Queue',
      {
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
        MaximumMessageSize: 262_144,
        VisibilityTimeout: 360,
      },
      2,
    );
    template.resourceCountIs('AWS::Events::EventBus', 1);
    template.hasResourceProperties('AWS::Events::EventBus', {
      KmsKeyIdentifier: Match.anyValue(),
    });
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['chief.connectors'],
        'detail-type': ['communication.ingest.requested'],
      },
      Targets: [
        Match.objectLike({
          DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
          RetryPolicy: {
            MaximumEventAgeInSeconds: 3600,
            MaximumRetryAttempts: 3,
          },
        }),
      ],
    });
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::TopicPolicy', 1);
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
            Condition: Match.objectLike({
              ArnEquals: Match.objectLike({
                'aws:SourceArn': Match.anyValue(),
              }),
              StringEquals: Match.objectLike({
                'aws:SourceAccount': '417242953053',
                'kms:EncryptionContext:aws:sns:topicArn': Match.anyValue(),
              }),
            }),
            Principal: { Service: 'sns.amazonaws.com' },
          }),
        ]),
      },
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    template.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      {
        AlarmActions: Match.anyValue(),
        ComparisonOperator: 'GreaterThanThreshold',
        DatapointsToAlarm: 1,
        EvaluationPeriods: 1,
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        OKActions: Match.anyValue(),
        Statistic: 'Maximum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      },
      2,
    );
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'key',
        PasswordLength: 64,
      }),
    });
  });

  it('binds every production composition explicitly and keeps all effects disabled', () => {
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Runtime: 'nodejs22.x',
        TracingConfig: { Mode: 'Active' },
        Environment: {
          Variables: Match.objectLike({
            EXTERNAL_EFFECTS: 'disabled',
            MODEL_EFFECTS: 'disabled',
            PROVIDER_EFFECTS: 'disabled',
            WORK_MANAGEMENT_EFFECTS: 'disabled',
            CORE_TABLE_NAME: Match.anyValue(),
          }),
        },
        LoggingConfig: {
          ApplicationLogLevel: 'INFO',
          LogFormat: 'JSON',
          SystemLogLevel: 'WARN',
        },
        Timeout: 60,
      },
      2,
    );
    const workers = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as SynthesizedWorkerResource[];
    expect(workers).toHaveLength(3);
    const workerEnvironments = workers.map(
      ({ Properties }) =>
        (
          Properties as {
            Environment?: { Variables?: Record<string, unknown> };
          }
        )?.Environment?.Variables ?? {},
    );
    const ingestionEnvironment = workerEnvironments.find(
      (environment) =>
        environment.POWERTOOLS_SERVICE_NAME === 'chief-ingestion-worker',
    );
    const executionEnvironment = workerEnvironments.find(
      (environment) =>
        environment.POWERTOOLS_SERVICE_NAME === 'chief-execution-worker',
    );
    const outboxRelayEnvironment = workerEnvironments.find(
      (environment) =>
        environment.POWERTOOLS_SERVICE_NAME === 'chief-outbox-relay',
    );
    expect(ingestionEnvironment).toMatchObject({
      INGESTION_ASANA_TOPIC_LOOKUP_INDEX_NAME: 'AsanaTopicLookupIndex',
      INGESTION_CONNECTOR_BINDINGS:
        'gmail=gmail@1.0.0,microsoft_graph=microsoft-graph@1.0.0-wave1a,imap=imap-smtp@1.0.0-protocol,twilio_sms=twilio-sms@1.0.0,twilio_whatsapp=twilio-whatsapp@1.0.0,x=x_legacy_dm@1.0.0,linkedin_archive=linkedin-communications@1.0.0-scaffold,asana=asana-work-management@1.0.0',
      INGESTION_IDENTITY_LOOKUP_INDEX_NAME: 'IdentityLookupIndex',
      INGESTION_RUNTIME_MODE: 'production',
      INGESTION_THREAD_LOOKUP_INDEX_NAME: 'ThreadLookupIndex',
    });
    for (const referenceName of [
      'CONNECTOR_RUNTIME_TABLE_NAME',
      'CORE_TABLE_NAME',
      'DIGEST_KEY_SECRET_ARN',
      'PRODUCT_DATA_KEY_ARN',
      'RETRIEVAL_TABLE_NAME',
      'SNAPSHOT_BUCKET_NAME',
    ]) {
      expectCdkReference(ingestionEnvironment?.[referenceName]);
    }
    expect(ingestionEnvironment).not.toHaveProperty('INGESTION_QUEUE_URL');
    expect(ingestionEnvironment).not.toHaveProperty('OUTBOX_QUEUE_URL');
    expect(ingestionEnvironment).not.toHaveProperty('PRODUCT_EVENT_BUS_NAME');
    expect(ingestionEnvironment?.INGESTION_CONNECTOR_BINDINGS).not.toContain(
      'demo=',
    );
    expect(executionEnvironment).toMatchObject({
      EXECUTION_LEASE_DURATION_MS: '120000',
      EXECUTION_RUNTIME_MODE: 'effect_disabled',
      EXECUTION_WORKER_ID: 'chief-execution-worker',
      EXTERNAL_EFFECTS: 'disabled',
      MODEL_EFFECTS: 'disabled',
      NODE_OPTIONS: '--enable-source-maps',
      POWERTOOLS_SERVICE_NAME: 'chief-execution-worker',
      PROVIDER_EFFECTS: 'disabled',
      WORK_MANAGEMENT_EFFECTS: 'disabled',
    });
    expectCdkReference(executionEnvironment?.CORE_TABLE_NAME);
    expect(Object.keys(executionEnvironment ?? {}).sort()).toEqual(
      [
        'CORE_TABLE_NAME',
        'EXECUTION_LEASE_DURATION_MS',
        'EXECUTION_RUNTIME_MODE',
        'EXECUTION_WORKER_ID',
        'EXTERNAL_EFFECTS',
        'MODEL_EFFECTS',
        'NODE_OPTIONS',
        'POWERTOOLS_SERVICE_NAME',
        'PROVIDER_EFFECTS',
        'WORK_MANAGEMENT_EFFECTS',
      ].sort(),
    );
    expect(outboxRelayEnvironment).toMatchObject({
      EXTERNAL_EFFECTS: 'disabled',
      MODEL_EFFECTS: 'disabled',
      NODE_OPTIONS: '--enable-source-maps',
      POWERTOOLS_METRICS_NAMESPACE: 'ChiefProduct',
      POWERTOOLS_SERVICE_NAME: 'chief-outbox-relay',
      PROVIDER_EFFECTS: 'disabled',
      WORK_MANAGEMENT_EFFECTS: 'disabled',
    });
    expectCdkReference(outboxRelayEnvironment?.OUTBOX_QUEUE_URL);
    expect(Object.keys(outboxRelayEnvironment ?? {}).sort()).toEqual(
      [
        'EXTERNAL_EFFECTS',
        'MODEL_EFFECTS',
        'NODE_OPTIONS',
        'OUTBOX_QUEUE_URL',
        'POWERTOOLS_METRICS_NAMESPACE',
        'POWERTOOLS_SERVICE_NAME',
        'PROVIDER_EFFECTS',
        'WORK_MANAGEMENT_EFFECTS',
      ].sort(),
    );
    const ingestionWorker = workers.find(
      ({ Properties }) =>
        (
          Properties as {
            Environment?: { Variables?: Record<string, unknown> };
          }
        )?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME ===
        'chief-ingestion-worker',
    );
    const executionWorker = workers.find(
      ({ Properties }) =>
        (
          Properties as {
            Environment?: { Variables?: Record<string, unknown> };
          }
        )?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME ===
        'chief-execution-worker',
    );
    const outboxRelayWorker = workers.find(
      ({ Properties }) =>
        (
          Properties as {
            Environment?: { Variables?: Record<string, unknown> };
          }
        )?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME ===
        'chief-outbox-relay',
    );
    expect(
      ingestionWorker?.Properties?.ReservedConcurrentExecutions,
    ).toBeUndefined();
    expect(
      executionWorker?.Properties?.ReservedConcurrentExecutions,
    ).toBeUndefined();
    expect(
      outboxRelayWorker?.Properties?.ReservedConcurrentExecutions,
    ).toBeUndefined();
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 3);
    template.resourcePropertiesCountIs(
      'AWS::Lambda::EventSourceMapping',
      {
        BatchSize: 10,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        MaximumBatchingWindowInSeconds: 5,
        ScalingConfig: { MaximumConcurrency: 2 },
      },
      2,
    );
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 90 },
      3,
    );
    const environments = workerEnvironments;
    expect(environments).toHaveLength(3);
    expect(
      environments.every((environment) => {
        return [
          'EXTERNAL_EFFECTS',
          'MODEL_EFFECTS',
          'PROVIDER_EFFECTS',
          'WORK_MANAGEMENT_EFFECTS',
        ].every((key) => environment[key] === 'disabled');
      }),
    ).toBe(true);
    expect(JSON.stringify(environments)).not.toMatch(
      /(?:bearer\s|sk-[a-z0-9]|gh[pousr]_|-----BEGIN)/iu,
    );
  });

  it('relays only new approval locator inserts with bounded partial-batch retries', () => {
    const failureBucketLogicalId = Object.entries(
      template.findResources('AWS::S3::Bucket'),
    ).find(([, resource]) =>
      JSON.stringify(resource).includes('OutboxRelayFailureCaptures'),
    )?.[0];
    expect(failureBucketLogicalId).toBeDefined();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      BisectBatchOnFunctionError: true,
      DestinationConfig: {
        OnFailure: {
          Destination: { 'Fn::GetAtt': [failureBucketLogicalId, 'Arn'] },
        },
      },
      FilterCriteria: {
        Filters: [
          {
            Pattern: Match.serializedJson({
              dynamodb: {
                NewImage: {
                  entityType: { S: ['approval_execution_locator'] },
                },
              },
              eventName: ['INSERT'],
            }),
          },
        ],
      },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      MaximumBatchingWindowInSeconds: 5,
      MaximumRecordAgeInSeconds: 86_400,
      MaximumRetryAttempts: 5,
      StartingPosition: 'TRIM_HORIZON',
    });
  });

  it('alerts separately when a complete relay payload is captured or capture delivery fails', () => {
    template.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      {
        AlarmActions: Match.anyValue(),
        AlarmDescription:
          'An object was written to the dedicated DynamoDB Streams relay failure bucket. Inspect the complete invocation payload and perform deliberate relay-aware recovery; the object is not directly redrivable.',
        ComparisonOperator: 'GreaterThanThreshold',
        DatapointsToAlarm: 1,
        Dimensions: Match.arrayWith([
          { Name: 'BucketName', Value: Match.anyValue() },
          { Name: 'FilterId', Value: 'OutboxRelayFailureCaptures' },
        ]),
        EvaluationPeriods: 1,
        MetricName: 'PutRequests',
        Namespace: 'AWS/S3',
        OKActions: Match.anyValue(),
        Period: 60,
        Statistic: 'Sum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      },
      1,
    );
    template.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      {
        AlarmActions: Match.anyValue(),
        AlarmDescription:
          'Lambda could not store a failed DynamoDB Streams relay invocation in S3. Inspect the relay role, bucket policy, and KMS key immediately; the complete recovery payload was not captured.',
        ComparisonOperator: 'GreaterThanThreshold',
        DatapointsToAlarm: 1,
        Dimensions: [{ Name: 'FunctionName', Value: Match.anyValue() }],
        EvaluationPeriods: 1,
        MetricName: 'DestinationDeliveryFailures',
        Namespace: 'AWS/Lambda',
        OKActions: Match.anyValue(),
        Period: 60,
        Statistic: 'Sum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      },
      1,
    );
  });

  it('gives the relay only stream-read, queue-send, and account-scoped failure-write authority', () => {
    const statements = workerPolicyStatements('OutboxRelayWorker');
    const actions = statements.flatMap(({ Action }) =>
      Array.isArray(Action) ? Action : Action === undefined ? [] : [Action],
    );
    const allowed = new Set([
      'dynamodb:DescribeStream',
      'dynamodb:GetRecords',
      'dynamodb:GetShardIterator',
      'dynamodb:ListStreams',
      'kms:Decrypt',
      'kms:DescribeKey',
      'kms:Encrypt',
      'kms:GenerateDataKey*',
      'kms:ReEncrypt*',
      's3:ListBucket',
      's3:PutObject',
      'sqs:GetQueueAttributes',
      'sqs:GetQueueUrl',
      'sqs:SendMessage',
      'xray:PutTelemetryRecords',
      'xray:PutTraceSegments',
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        'dynamodb:DescribeStream',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:ListStreams',
        's3:ListBucket',
        's3:PutObject',
        'sqs:SendMessage',
      ]),
    );
    expect(actions.every((action) => allowed.has(action))).toBe(true);

    const dataPlaneStatements = statements.filter(({ Action }) => {
      const values = Array.isArray(Action)
        ? Action
        : Action === undefined
          ? []
          : [Action];
      return values.some((action) => /^(?:dynamodb|kms|s3|sqs):/u.test(action));
    });
    expect(dataPlaneStatements).not.toHaveLength(0);
    expect(
      dataPlaneStatements.every(({ Action, Resource }) => {
        if (Array.isArray(Resource)) return !Resource.includes('*');
        if (Resource !== '*') return true;
        return Action === 'dynamodb:ListStreams';
      }),
    ).toBe(true);
    expect(
      statements
        .filter(({ Resource }) => Resource === '*')
        .map(({ Action, Resource }) => ({ Action, Resource })),
    ).toEqual([
      {
        Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        Resource: '*',
      },
      { Action: 'dynamodb:ListStreams', Resource: '*' },
    ]);
    expect(JSON.stringify(statements)).toContain('CoreDomainTable');
    expect(JSON.stringify(statements)).toContain('OutboxQueue');
    expect(JSON.stringify(statements)).toContain('OutboxRelayFailureBucket');
    const s3Statements = statements.filter(({ Action }) =>
      (Array.isArray(Action) ? Action : [Action]).some((action) =>
        action?.startsWith('s3:'),
      ),
    );
    expect(s3Statements).toHaveLength(1);
    expect(s3Statements[0]).toMatchObject({
      Action: ['s3:ListBucket', 's3:PutObject'],
      Condition: {
        StringEquals: { 's3:ResourceAccount': '417242953053' },
      },
      Effect: 'Allow',
    });
    expect(JSON.stringify(s3Statements[0]?.Resource)).toContain(
      'OutboxRelayFailureBucket',
    );
    expect(JSON.stringify(s3Statements[0]?.Resource)).not.toContain('"*"');
    expect(JSON.stringify(statements)).not.toMatch(
      /ConnectorRuntimeTable|RetrievalTable|SnapshotBlobBucket|DigestKeySecret/u,
    );
  });

  it('gives ingestion only resource-scoped persistence and secret-reference authority', () => {
    const statements = workerPolicyStatements('IngestionWorker');
    const actions = statements.flatMap(({ Action }) =>
      Array.isArray(Action) ? Action : Action === undefined ? [] : [Action],
    );

    expect(actions).toEqual(
      expect.arrayContaining([
        'dynamodb:Query',
        'dynamodb:TransactWriteItems',
        's3:GetObject*',
        's3:PutObject',
        'secretsmanager:GetSecretValue',
        'sqs:ReceiveMessage',
      ]),
    );
    expect(actions).not.toEqual(
      expect.arrayContaining([
        'bedrock:InvokeModel',
        'events:PutEvents',
        'lambda:InvokeFunction',
        'ses:SendEmail',
        'sns:Publish',
        'sqs:SendMessage',
      ]),
    );
    const dataPlaneStatements = statements.filter(({ Action }) => {
      const values = Array.isArray(Action)
        ? Action
        : Action === undefined
          ? []
          : [Action];
      return values.some((action) =>
        /^(?:dynamodb|kms|s3|secretsmanager|sqs):/u.test(action),
      );
    });
    expect(dataPlaneStatements).not.toHaveLength(0);
    expect(
      dataPlaneStatements.every(({ Resource }) => {
        if (Array.isArray(Resource)) return !Resource.includes('*');
        return Resource !== '*';
      }),
    ).toBe(true);

    const secretStatements = statements.filter(({ Action }) => {
      const values = Array.isArray(Action)
        ? Action
        : Action === undefined
          ? []
          : [Action];
      return values.some((action) => action.startsWith('secretsmanager:'));
    });
    expect(secretStatements).toHaveLength(1);
    expect(JSON.stringify(secretStatements)).toContain('DigestKeySecret');
  });

  it('gives execution only its core records and queue consumer authority', () => {
    const statements = workerPolicyStatements('ExecutionWorker');
    const actionResources = statements.flatMap(({ Action, Resource }) => {
      const actions = Array.isArray(Action)
        ? Action
        : Action === undefined
          ? []
          : [Action];
      return actions.map((action) => ({ action, resource: Resource }));
    });
    const actions = actionResources.map(({ action }) => action);

    expect(actions.sort()).toEqual(
      [
        'dynamodb:GetItem',
        'dynamodb:TransactGetItems',
        'dynamodb:UpdateItem',
        'kms:Decrypt',
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
        'xray:PutTelemetryRecords',
        'xray:PutTraceSegments',
      ].sort(),
    );

    const dynamoStatements = statements.filter(({ Action }) => {
      const values = Array.isArray(Action)
        ? Action
        : Action === undefined
          ? []
          : [Action];
      return values.some((action) => action.startsWith('dynamodb:'));
    });
    expect(dynamoStatements).toHaveLength(1);
    expect(JSON.stringify(dynamoStatements)).toContain('CoreDomainTable');
    expect(JSON.stringify(dynamoStatements)).not.toContain('/index/');
    expect(JSON.stringify(statements)).not.toMatch(
      /ConnectorRuntimeTable|RetrievalTable|SnapshotBlobBucket|ProductEventBus|DigestKeySecret/u,
    );
  });

  it('grants queue consumers without mutable-fact or scan permissions', () => {
    const actions = allActions();
    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:DeleteMessage');
    expect(actions).toContain('dynamodb:TransactWriteItems');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:DeleteItem');
    expect(actions).not.toContain('dynamodb:BatchWriteItem');
    expect(actions).not.toContain('s3:DeleteObject*');

    const dataPlaneStatements = allPolicyStatements().filter(({ Action }) => {
      const values = Array.isArray(Action) ? Action : Action ? [Action] : [];
      return values.some((action) =>
        /^(?:dynamodb|events|kms|s3|secretsmanager|sqs):/u.test(action),
      );
    });
    expect(dataPlaneStatements.length).toBeGreaterThan(0);
    expect(
      dataPlaneStatements.every(({ Action, Resource }) => {
        if (Array.isArray(Resource)) return !Resource.includes('*');
        if (Resource !== '*') return true;
        return Action === 'dynamodb:ListStreams';
      }),
    ).toBe(true);
  });

  it('exports stable runtime bindings without provisioning OpenSearch', () => {
    const outputs = template.toJSON().Outputs as Record<
      string,
      { Export?: { Name?: string }; Value: unknown }
    >;
    const exportNames = Object.values(outputs)
      .map((output) => output.Export?.Name)
      .filter((value): value is string => value !== undefined);
    expect(exportNames).toEqual(
      expect.arrayContaining([
        'chief-communications:runtime:core-table-name',
        'chief-communications:runtime:connector-runtime-table-name',
        'chief-communications:runtime:retrieval-table-name',
        'chief-communications:runtime:snapshot-bucket-name',
        'chief-communications:runtime:ingestion-queue-url',
        'chief-communications:runtime:outbox-queue-url',
        'chief-communications:runtime:event-bus-name',
        'chief-communications:runtime:digest-key-secret-arn',
        'chief-communications:runtime:data-key-arn',
      ]),
    );
    expect(template.findResources('AWS::OpenSearchService::Domain')).toEqual(
      {},
    );
    expect(
      template.findResources('AWS::OpenSearchServerless::Collection'),
    ).toEqual({});
  });

  it('orders product exports before foundation imports', () => {
    const app = new cdk.App();
    const foundation = new ChiefFoundationStack(app, 'ChiefFoundationStack', {
      env: { account: '417242953053', region: 'us-east-2' },
    });
    const product = new ChiefProductStack(app, 'ChiefProductStack', {
      env: { account: '417242953053', region: 'us-east-2' },
    });
    // This test builds a second App with BOTH stacks, forcing a full re-bundle of
    // four Lambda assets (~38s observed), unlike the other tests which reuse the
    // module-scope template bundled once at import. Budget accordingly.
    expect(foundation.dependencies).toContain(product);
  }, 90_000);

  it('synthesizes importable CommonJS worker assets', () => {
    const outputDirectory = mkdtempSync(
      path.join(tmpdir(), 'chief-product-assets-'),
    );

    try {
      const app = new cdk.App({ outdir: outputDirectory });
      const stack = new ChiefProductStack(app, 'AssetChiefProduct', {
        env: { account: '417242953053', region: 'us-east-2' },
      });
      const assembly = app.synth();
      const synthesizedTemplate = assembly.getStackArtifact(stack.artifactId)
        .template as SynthesizedTemplate;
      const bundles = workerLambdaBundles(synthesizedTemplate, outputDirectory);

      for (const bundlePath of bundles.values()) {
        const bundleSource = readFileSync(bundlePath, 'utf8');
        expect(bundleSource).not.toContain(
          'import { createRequire } from module;',
        );
        const loadedBundle = require(bundlePath) as { handler?: unknown };
        expect(typeof loadedBundle.handler).toBe('function');
      }
    } finally {
      rmSync(outputDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});

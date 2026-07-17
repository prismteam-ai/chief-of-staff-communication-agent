import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ChiefFoundationStack } from '../lib/chief-foundation-stack.js';
import { ChiefProductStack } from '../lib/chief-product-stack.js';

function createProductTemplate(): Template {
  const app = new cdk.App();
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
  readonly Resource?: unknown;
}> {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as Array<{
    Properties?: {
      PolicyDocument?: {
        Statement?: Array<{
          readonly Action?: string | string[];
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
  functionId: 'ExecutionWorker' | 'IngestionWorker',
): Array<{
  readonly Action?: string | string[];
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
    template.resourceCountIs('AWS::S3::Bucket', 1);
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
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
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

  it('binds the production ingestion composition explicitly and keeps all effects disabled', () => {
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
            CONNECTOR_RUNTIME_TABLE_NAME: Match.anyValue(),
            RETRIEVAL_TABLE_NAME: Match.anyValue(),
            SNAPSHOT_BUCKET_NAME: Match.anyValue(),
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
    expect(workers).toHaveLength(2);
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
    for (const referenceName of [
      'INGESTION_QUEUE_URL',
      'OUTBOX_QUEUE_URL',
      'PRODUCT_EVENT_BUS_NAME',
    ]) {
      expectCdkReference(executionEnvironment?.[referenceName]);
    }
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
    expect(ingestionWorker?.Properties?.ReservedConcurrentExecutions).toBe(2);
    expect(
      executionWorker?.Properties?.ReservedConcurrentExecutions,
    ).toBeUndefined();
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
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
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 90 },
      2,
    );
    const environments = workerEnvironments;
    expect(environments).toHaveLength(2);
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
      dataPlaneStatements.every(({ Resource }) => {
        if (Array.isArray(Resource)) return !Resource.includes('*');
        return Resource !== '*';
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
    expect(foundation.dependencies).toContain(product);
  }, 20_000);
});

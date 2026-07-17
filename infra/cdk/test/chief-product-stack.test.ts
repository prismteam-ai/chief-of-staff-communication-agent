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

  it('binds both workers to shared resources with effects disabled', () => {
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
            INGESTION_QUEUE_URL: Match.anyValue(),
            OUTBOX_QUEUE_URL: Match.anyValue(),
            PRODUCT_EVENT_BUS_NAME: Match.anyValue(),
            DIGEST_KEY_SECRET_ARN: Match.anyValue(),
          }),
        },
        Timeout: 60,
      },
      2,
    );
    const workers = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as SynthesizedWorkerResource[];
    expect(workers).toHaveLength(2);
    expect(
      workers.every(
        ({ Properties }) =>
          Properties?.ReservedConcurrentExecutions === undefined,
      ),
    ).toBe(true);
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
    const environments = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ).map(
      (resource) =>
        (resource as { Properties: { Environment: { Variables: object } } })
          .Properties.Environment.Variables,
    );
    expect(environments).toHaveLength(2);
    expect(
      environments.every((environment) => {
        const switches = environment as Record<string, unknown>;
        return [
          'EXTERNAL_EFFECTS',
          'MODEL_EFFECTS',
          'PROVIDER_EFFECTS',
          'WORK_MANAGEMENT_EFFECTS',
        ].every((key) => switches[key] === 'disabled');
      }),
    ).toBe(true);
    expect(JSON.stringify(environments)).not.toMatch(
      /(?:bearer\s|sk-[a-z0-9]|gh[pousr]_|-----BEGIN)/iu,
    );
  });

  it('grants a queue producer and consumer without mutable-fact or scan permissions', () => {
    const actions = allActions();
    expect(actions).toContain('sqs:SendMessage');
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

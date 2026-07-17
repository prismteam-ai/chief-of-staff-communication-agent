import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
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

  it('creates the encrypted queue/DLQ, product bus, and digest-key secret', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.resourcePropertiesCountIs(
      'AWS::SQS::Queue',
      { KmsMasterKeyId: Match.anyValue() },
      2,
    );
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.resourceCountIs('AWS::Events::EventBus', 1);
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
            CORE_TABLE_NAME: Match.anyValue(),
            CONNECTOR_RUNTIME_TABLE_NAME: Match.anyValue(),
            RETRIEVAL_TABLE_NAME: Match.anyValue(),
            SNAPSHOT_BUCKET_NAME: Match.anyValue(),
            OUTBOX_QUEUE_URL: Match.anyValue(),
            PRODUCT_EVENT_BUS_NAME: Match.anyValue(),
            DIGEST_KEY_SECRET_ARN: Match.anyValue(),
          }),
        },
      },
      2,
    );
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    const environments = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ).map(
      (resource) =>
        (resource as { Properties: { Environment: { Variables: object } } })
          .Properties.Environment.Variables,
    );
    expect(environments).toHaveLength(2);
    expect(
      environments.every(
        (environment) =>
          (environment as { EXTERNAL_EFFECTS?: string }).EXTERNAL_EFFECTS ===
          'disabled',
      ),
    ).toBe(true);
  });

  it('grants a queue producer and consumer without mutable-fact or scan permissions', () => {
    const actions = allActions();
    expect(actions).toContain('sqs:SendMessage');
    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:DeleteMessage');
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('dynamodb:DeleteItem');
    expect(actions).not.toContain('dynamodb:BatchWriteItem');
    expect(actions).not.toContain('s3:DeleteObject*');
  });
});

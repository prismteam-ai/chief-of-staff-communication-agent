import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * The DynamoDB tables and S3 raw-artifact bucket backing the account model, the communication
 * state machine, ingest idempotency, and style learning (design.md §5, §6, §10; brief constraint
 * 5). Instantiated once in `IngestStack` and consumed by name/ARN from later stacks (Api, Agent) —
 * a reusable construct rather than stack-local resources so ownership stays in one place.
 *
 * Demo-scoped choices, applied uniformly: `PAY_PER_REQUEST` billing (no capacity planning for
 * demo-scale traffic), `RemovalPolicy.DESTROY` (this is a throwaway demo environment, not
 * production data), point-in-time recovery left off (no production continuity requirement here).
 * Tags are inherited from the enclosing `TaggedStack`'s `project_name` Aspect — nothing extra to
 * wire per table.
 */
export class DataTables extends Construct {
  /** PK `commId` — one item per communication; GSI `byAccountStatus` for account+status queries. */
  public readonly communicationsTable: dynamodb.Table;

  /** PK `accountId` — the account/ownership record `assertAccountAccess` reads through. */
  public readonly accountsTable: dynamodb.Table;

  /** PK `dedupeKey` (provider `externalId`-derived) — conditional-write idempotency store, TTL. */
  public readonly dedupeTable: dynamodb.Table;

  /** PK `userId` — the learned per-user style profile (design.md §6). */
  public readonly styleProfilesTable: dynamodb.Table;

  /** PK `tokenHash` (SHA-256 of the plaintext token, never the token itself) — per-user MCP tokens
   * the Cursor MCP server authenticates with (Task 11, design.md §8). */
  public readonly mcpTokensTable: dynamodb.Table;

  /** Raw provider payloads and attachments (design.md §4 "S3 for raw artifacts and attachments"). */
  public readonly rawArtifactBucket: s3.Bucket;

  public static readonly ACCOUNT_STATUS_INDEX = 'byAccountStatus';

  constructor(scope: Construct, id: string, props?: { readonly resourcePrefix?: string }) {
    super(scope, id);

    const prefix = props?.resourcePrefix ?? 'chief-of-staff';

    this.communicationsTable = new dynamodb.Table(this, 'CommunicationsTable', {
      tableName: `${prefix}-communications`,
      partitionKey: { name: 'commId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.communicationsTable.addGlobalSecondaryIndex({
      indexName: DataTables.ACCOUNT_STATUS_INDEX,
      partitionKey: { name: 'accountId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.accountsTable = new dynamodb.Table(this, 'AccountsTable', {
      tableName: `${prefix}-accounts`,
      partitionKey: { name: 'accountId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.dedupeTable = new dynamodb.Table(this, 'DedupeTable', {
      tableName: `${prefix}-dedupe`,
      partitionKey: { name: 'dedupeKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });

    this.styleProfilesTable = new dynamodb.Table(this, 'StyleProfilesTable', {
      tableName: `${prefix}-style-profiles`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.mcpTokensTable = new dynamodb.Table(this, 'McpTokensTable', {
      tableName: `${prefix}-mcp-tokens`,
      partitionKey: { name: 'tokenHash', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.rawArtifactBucket = new s3.Bucket(this, 'RawArtifactBucket', {
      bucketName: `${prefix}-raw-artifacts-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
  }
}

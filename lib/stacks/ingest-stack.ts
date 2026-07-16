import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';
import { DataTables } from '../constructs/data-tables.js';
import { PROJECT_NAME } from '../constructs/tags.js';

/**
 * Owns the account model, communication-state, dedupe, and style-profile DynamoDB tables plus the
 * S3 raw-artifact bucket (design.md §5, §10; brief constraint 5) via the reusable `DataTables`
 * construct — table/bucket ownership lives here so later stacks (Api, Agent) consume names/ARNs
 * rather than re-declaring the resources. Task 3 adds the webhook Lambdas, EventBridge Scheduler
 * poller, and SQS (+DLQ) processing pipeline alongside these tables.
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
  }
}

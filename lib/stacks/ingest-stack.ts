import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TaggedStack } from '../constructs/tagged-stack.js';

/**
 * Empty-but-deployable placeholder. Task 3 adds the webhook Lambdas,
 * EventBridge Scheduler poller, and SQS (+DLQ) processing pipeline.
 */
export class IngestStack extends TaggedStack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
